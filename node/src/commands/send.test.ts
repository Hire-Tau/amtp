// The CLI's `send` command builds its engine via `buildNodeEngine` (no fetch
// injection point by design — spec §4/§2 "late-bound `fetch`", never a
// reference captured at construction). To exercise the CLI wiring end-to-end
// without real network, these tests stub `globalThis.fetch` itself for the
// duration of each test — exactly the seam `drainOutboxOnce`'s
// `opts.fetch ?? globalThis.fetch` resolves against at call time.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'bun:sqlite'
import { generateInstanceKeyPair, instanceIdFromPublicKeyPem } from 'amtp-protocol'
import { setCliHome } from '../context'
import { openDb } from '../db/open'
import { dbPath, ensureAmtpDirs } from '../home'
import { runInit } from '../ops/init'
import { addPeer } from '../ops/peers'
import { register } from '../ops/registrations'
import type { SendResult } from '../ops/send'
import { setOutputOptions } from '../output'
import { registerSendCommand } from './send'
import { captureLogs, newProgram, parseJsonLog } from './test-helpers'

let workDir: string
let home: string
let peerInstanceId: string
let originalFetch: typeof globalThis.fetch

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'amtp-send-cmd-test-'))
  home = join(workDir, 'home')
  ensureAmtpDirs(home)
  setCliHome(home)
  const init = runInit(home)

  const db: Database = openDb(dbPath(home))
  register(db, init.instanceId, { handle: 'alice' })
  const peerKeys = generateInstanceKeyPair()
  peerInstanceId = instanceIdFromPublicKeyPem(peerKeys.publicKeyPem)
  addPeer(db, { alias: 'bob-peer', baseUrl: 'http://peer.example', publicKeyPem: peerKeys.publicKeyPem })
  db.close()

  setOutputOptions({ json: true })
  originalFetch = globalThis.fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  setOutputOptions({})
  rmSync(workDir, { recursive: true, force: true })
})

function buildProgram() {
  const program = newProgram()
  registerSendCommand(program)
  return program
}

describe('amtp send', () => {
  test('is registered with the expected shape', () => {
    const program = buildProgram()
    const send = program.commands.find((c) => c.name() === 'send')
    expect(send?.registeredArguments.map((a) => a.name())).toEqual(['to', 'content'])
  })

  test('enqueues + drains, reporting a delivered status from the stubbed peer', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ accepted: true }), { status: 200 })) as unknown as typeof fetch

    const logs = await captureLogs(() =>
      buildProgram().parseAsync(['send', `amtp://${peerInstanceId}/bob`, 'hello from the cli'], { from: 'user' })
    )
    const result = parseJsonLog<SendResult>(logs)
    expect(result.status).toBe('delivered')
  })

  test('--queue-only skips the drain (status pending, fetch never called)', async () => {
    let called = false
    globalThis.fetch = (async () => {
      called = true
      return new Response(JSON.stringify({ accepted: true }), { status: 200 })
    }) as unknown as typeof fetch

    const logs = await captureLogs(() =>
      buildProgram().parseAsync(['send', `amtp://${peerInstanceId}/bob`, 'queued message', '--queue-only'], {
        from: 'user',
      })
    )
    const result = parseJsonLog<SendResult>(logs)
    expect(result.status).toBe('pending')
    expect(called).toBe(false)
  })
})
