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
import { registerHandlesCommand } from './handles'
import { newProgram } from './test-helpers'

let workDir: string
let home: string
let peerInstanceId: string
let originalFetch: typeof globalThis.fetch

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'amtp-handles-cmd-test-'))
  home = join(workDir, 'home')
  ensureAmtpDirs(home)
  setCliHome(home)
  runInit(home)

  const db: Database = openDb(dbPath(home))
  const peerKeys = generateInstanceKeyPair()
  peerInstanceId = instanceIdFromPublicKeyPem(peerKeys.publicKeyPem)
  addPeer(db, { alias: 'bob-peer', baseUrl: 'http://peer.example', publicKeyPem: peerKeys.publicKeyPem })
  db.close()

  originalFetch = globalThis.fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  rmSync(workDir, { recursive: true, force: true })
})

function buildProgram() {
  const program = newProgram()
  registerHandlesCommand(program)
  return program
}

describe('amtp handles <peer>', () => {
  test('is registered with a required peer argument', () => {
    const program = buildProgram()
    const handles = program.commands.find((c) => c.name() === 'handles')
    expect(handles?.registeredArguments.map((a) => a.name())).toEqual(['peer'])
  })

  test("fetches and prints the stub peer's handles", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ handles: [{ handle: 'bob' }] }), { status: 200 })) as unknown as typeof fetch

    const logs: unknown[] = []
    const originalLog = console.log
    console.log = (...args: unknown[]) => logs.push(args.join(' '))
    try {
      await buildProgram().parseAsync(['handles', 'bob-peer'], { from: 'user' })
    } finally {
      console.log = originalLog
    }

    expect(logs.some((line) => String(line).includes('bob'))).toBe(true)
    expect(logs.some((line) => String(line).includes(peerInstanceId))).toBe(true)
  })
})
