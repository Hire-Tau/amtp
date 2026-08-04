import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'bun:sqlite'
import { createAmtpEngine } from 'amtp-engine'
import { formatAmtpAddress, generateInstanceKeyPair, instanceIdFromPublicKeyPem } from 'amtp-protocol'
import { buildAdapters } from '../adapters'
import { openDb } from '../db/open'
import { dbPath, ensureAmtpDirs } from '../home'
import { runInit } from './init'
import { addPeer } from './peers'
import { fetchPeerHandles } from './handles'

let workDir: string
let home: string
let db: Database
let peerInstanceId: string

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'amtp-handles-test-'))
  home = join(workDir, 'home')
  ensureAmtpDirs(home)
  runInit(home)
  db = openDb(dbPath(home))
  const peerKeys = generateInstanceKeyPair()
  peerInstanceId = instanceIdFromPublicKeyPem(peerKeys.publicKeyPem)
  addPeer(db, { alias: 'bob-peer', baseUrl: 'http://peer.example', publicKeyPem: peerKeys.publicKeyPem })
})

afterEach(() => {
  db.close()
  rmSync(workDir, { recursive: true, force: true })
})

type FetchStub = (url: string | URL | Request, init?: RequestInit) => Promise<Response>

function buildEngineWithFetch(fetchImpl: FetchStub) {
  return createAmtpEngine(buildAdapters(db, home), { fetch: fetchImpl as unknown as typeof globalThis.fetch })
}

describe('fetchPeerHandles', () => {
  test("lists the stub peer's handles as full amtp:// addresses", async () => {
    const engine = buildEngineWithFetch(
      async () => new Response(JSON.stringify({ handles: [{ handle: 'bob' }, { handle: 'carol' }] }), { status: 200 })
    )

    const handles = await fetchPeerHandles(engine, db, 'bob-peer')
    expect(handles).toEqual([
      { handle: 'bob', address: formatAmtpAddress(peerInstanceId, 'bob') },
      { handle: 'carol', address: formatAmtpAddress(peerInstanceId, 'carol') },
    ])
  })

  test('resolves the peer by instance id too', async () => {
    const engine = buildEngineWithFetch(async () => new Response(JSON.stringify({ handles: [] }), { status: 200 }))
    await expect(fetchPeerHandles(engine, db, peerInstanceId)).resolves.toEqual([])
  })

  test('throws for an unknown peer ref', async () => {
    const engine = buildEngineWithFetch(async () => new Response('{}', { status: 200 }))
    await expect(fetchPeerHandles(engine, db, 'ghost')).rejects.toThrow(/unknown peer/)
  })

  test('throws when the peer request fails', async () => {
    const engine = buildEngineWithFetch(async () => new Response('nope', { status: 500 }))
    await expect(fetchPeerHandles(engine, db, 'bob-peer')).rejects.toThrow(/failed to fetch handles/)
  })

  test('passes name/description hints through intact', async () => {
    const engine = buildEngineWithFetch(
      async () =>
        new Response(JSON.stringify({ handles: [{ handle: 'bob', name: 'Bob', description: 'Support' }] }), {
          status: 200,
        })
    )
    const handles = await fetchPeerHandles(engine, db, 'bob-peer')
    expect(handles).toEqual([
      { handle: 'bob', address: formatAmtpAddress(peerInstanceId, 'bob'), name: 'Bob', description: 'Support' },
    ])
  })

  test('omits name/description keys entirely when the peer sends no hints', async () => {
    const engine = buildEngineWithFetch(
      async () => new Response(JSON.stringify({ handles: [{ handle: 'bob' }] }), { status: 200 })
    )
    const [handle] = await fetchPeerHandles(engine, db, 'bob-peer')
    expect(Object.keys(handle).sort()).toEqual(['address', 'handle'])
  })
})
