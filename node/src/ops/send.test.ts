// Spec: docs/superpowers/specs/2026-07-08-amtp-node-design.md §7.1/§7.2, §9.
// Delivery is exercised against a stub peer via injected `fetch` — no real
// network — per the engine's late-bound fetch seam (`createAmtpEngine`'s
// `opts.fetch`). Constructing the engine directly via `createAmtpEngine` +
// this package's `buildAdapters` (rather than the production `buildNodeEngine`,
// which deliberately never accepts a fetch override) is the seam: `ops/send.ts`
// itself only depends on the `AmtpEngine` interface, so a test-only engine
// wired this way exercises the exact same send/enqueue/drain code path.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'bun:sqlite'
import { createAmtpEngine } from 'amtp-engine'
import type { AmtpEngine } from 'amtp-engine'
import {
  canonicalAgentSigBytes,
  formatAmtpAddress,
  generateInstanceKeyPair,
  instanceIdFromPublicKeyPem,
  verifyEnvelope,
} from 'amtp-protocol'
import type { AmtpEnvelope } from 'amtp-protocol'
import { buildAdapters } from '../adapters'
import { openDb } from '../db/open'
import { dbPath, ensureAmtpDirs } from '../home'
import { addPeer } from './peers'
import { runInit } from './init'
import { register } from './registrations'
import { send } from './send'
import { uploadAttachment } from './attach'

let workDir: string
let home: string
let db: Database
let instanceId: string
let peerInstanceId: string
let peerBaseUrl: string

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'amtp-send-test-'))
  home = join(workDir, 'home')
  ensureAmtpDirs(home)
  const init = runInit(home)
  instanceId = init.instanceId
  db = openDb(dbPath(home))
  register(db, instanceId, { handle: 'alice' })

  const peerKeys = generateInstanceKeyPair()
  peerInstanceId = instanceIdFromPublicKeyPem(peerKeys.publicKeyPem)
  peerBaseUrl = 'http://peer.example'
  addPeer(db, { alias: 'bob-peer', baseUrl: peerBaseUrl, publicKeyPem: peerKeys.publicKeyPem })
})

afterEach(() => {
  db.close()
  rmSync(workDir, { recursive: true, force: true })
})

type FetchStub = (url: string | URL | Request, init?: RequestInit) => Promise<Response>

function buildEngineWithFetch(fetchImpl: FetchStub): AmtpEngine {
  return createAmtpEngine(buildAdapters(db, home), { fetch: fetchImpl as unknown as typeof globalThis.fetch })
}

const TO = () => formatAmtpAddress(peerInstanceId, 'bob')

describe('send', () => {
  test('delivers to an active peer whose stub 2xxs, reporting status "delivered"', async () => {
    let deliveredBody: AmtpEnvelope | undefined
    const engine = buildEngineWithFetch(async (url, init) => {
      expect(String(url)).toBe(`${peerBaseUrl}/amtp/inbox`)
      deliveredBody = JSON.parse(String(init?.body)) as AmtpEnvelope
      return new Response(JSON.stringify({ accepted: true }), { status: 200 })
    })

    const result = await send(db, engine, { toAddress: TO(), content: 'hello', subject: 'hi' })

    expect(result.status).toBe('delivered')
    expect(result.outboxId).toBeTruthy()
    expect(result.envelopeId).toBeTruthy()
    expect(deliveredBody?.content).toBe('hello')
    expect(deliveredBody?.from).toBe(formatAmtpAddress(instanceId, 'alice'))
  })

  test('signs by default: agentSig verifies against the canonical §9 subset', async () => {
    let deliveredBody: AmtpEnvelope | undefined
    const engine = buildEngineWithFetch(async (_url, init) => {
      deliveredBody = JSON.parse(String(init?.body)) as AmtpEnvelope
      return new Response(JSON.stringify({ accepted: true }), { status: 200 })
    })

    await send(db, engine, { toAddress: TO(), content: 'signed message' })

    expect(deliveredBody?.agentSig).toBeTruthy()
    expect(deliveredBody?.agentKey).toBeTruthy()
    const bytes = canonicalAgentSigBytes({
      v: 1,
      id: deliveredBody!.id,
      from: deliveredBody!.from,
      to: deliveredBody!.to,
      subject: deliveredBody!.subject,
      content: deliveredBody!.content,
      attachments: [],
    })
    expect(verifyEnvelope(deliveredBody!.agentKey!, bytes, deliveredBody!.agentSig!)).toBe(true)
  })

  test('--no-sign (sign: false) omits agentKey/agentSig', async () => {
    let deliveredBody: AmtpEnvelope | undefined
    const engine = buildEngineWithFetch(async (_url, init) => {
      deliveredBody = JSON.parse(String(init?.body)) as AmtpEnvelope
      return new Response(JSON.stringify({ accepted: true }), { status: 200 })
    })

    await send(db, engine, { toAddress: TO(), content: 'unsigned', sign: false })

    expect(deliveredBody?.agentSig).toBeUndefined()
    expect(deliveredBody?.agentKey).toBeUndefined()
  })

  test('--queue-only leaves the entry pending and never calls fetch', async () => {
    let fetchCalled = false
    const engine = buildEngineWithFetch(async () => {
      fetchCalled = true
      return new Response(JSON.stringify({ accepted: true }), { status: 200 })
    })

    const result = await send(db, engine, { toAddress: TO(), content: 'queued', queueOnly: true })

    expect(fetchCalled).toBe(false)
    expect(result.status).toBe('pending')
    expect(result.nextAttemptAt).toBeGreaterThan(0)
  })

  test('a terminal (non-retryable) HTTP status is reported as "failed" with lastError', async () => {
    const engine = buildEngineWithFetch(async () => new Response(JSON.stringify({ error: 'nope' }), { status: 404 }))

    const result = await send(db, engine, { toAddress: TO(), content: 'will bounce' })

    expect(result.status).toBe('failed')
    expect(result.lastError).toContain('404')
  })

  test('--envelope-id makes send idempotent: a re-run with the same id returns the existing outbox entry', async () => {
    let deliveryCount = 0
    const engine = buildEngineWithFetch(async () => {
      deliveryCount++
      return new Response(JSON.stringify({ accepted: true }), { status: 200 })
    })

    const envelopeId = '11111111-1111-1111-1111-111111111111'
    const first = await send(db, engine, { toAddress: TO(), content: 'once', envelopeId })
    const second = await send(db, engine, { toAddress: TO(), content: 'once', envelopeId })

    expect(second.outboxId).toBe(first.outboxId)
    expect(second.envelopeId).toBe(envelopeId)
    // First call actually delivers; the second call's own enqueue is a no-op onto the
    // already-delivered row, and its own drain finds nothing due to redeliver.
    expect(deliveryCount).toBe(1)
  })

  test('--from defaults when exactly one handle is registered', async () => {
    const engine = buildEngineWithFetch(async () => new Response(JSON.stringify({ accepted: true }), { status: 200 }))
    const result = await send(db, engine, { toAddress: TO(), content: 'default from' })
    expect(result.status).toBe('delivered')
  })

  test('--from is required when multiple handles are registered', async () => {
    register(db, instanceId, { handle: 'carol' })
    const engine = buildEngineWithFetch(async () => new Response(JSON.stringify({ accepted: true }), { status: 200 }))
    await expect(send(db, engine, { toAddress: TO(), content: 'ambiguous' })).rejects.toThrow(/--from is required/)
  })

  test('throws when --from names an unregistered handle', async () => {
    const engine = buildEngineWithFetch(async () => new Response(JSON.stringify({ accepted: true }), { status: 200 }))
    await expect(send(db, engine, { toAddress: TO(), content: 'x', fromHandle: 'ghost' })).rejects.toThrow(
      /not registered/
    )
  })

  test('--attach-id resolves a staged outbound attachment into the envelope', async () => {
    const fixturePath = join(workDir, 'upload-fixture.txt')
    writeFileSync(fixturePath, 'attachment bytes')
    const staged = uploadAttachment(db, home, fixturePath)

    let deliveredBody: AmtpEnvelope | undefined
    const engine = buildEngineWithFetch(async (_url, init) => {
      deliveredBody = JSON.parse(String(init?.body)) as AmtpEnvelope
      return new Response(JSON.stringify({ accepted: true }), { status: 200 })
    })

    const result = await send(db, engine, {
      toAddress: TO(),
      content: 'with attachment',
      attachIds: [staged.attachmentId],
    })

    expect(result.status).toBe('delivered')
    expect(deliveredBody?.attachments).toEqual([
      {
        id: staged.attachmentId,
        filename: 'upload-fixture.txt',
        contentType: 'application/octet-stream',
        byteSize: staged.byteSize,
        sha256: staged.sha256,
      },
    ])
  })

  test('rejects an unknown --attach-id', async () => {
    const engine = buildEngineWithFetch(async () => new Response(JSON.stringify({ accepted: true }), { status: 200 }))
    await expect(send(db, engine, { toAddress: TO(), content: 'x', attachIds: ['ghost-attachment'] })).rejects.toThrow(
      /unknown outbound attachment/
    )
  })

  test('rejects an invalid amtp:// address', async () => {
    const engine = buildEngineWithFetch(async () => new Response(JSON.stringify({ accepted: true }), { status: 200 }))
    await expect(send(db, engine, { toAddress: 'not-an-amtp-address', content: 'x' })).rejects.toThrow(/invalid amtp/)
  })
})
