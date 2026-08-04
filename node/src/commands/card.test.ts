// `amtp card set|show|clear|fetch` (spec §4.6, §7.2).

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'bun:sqlite'
import { generateInstanceKeyPair, instanceIdFromPublicKeyPem, signAgentCard } from 'amtp-protocol'
import type { AmtpSignedAgentCard } from 'amtp-protocol'
import { setCliHome } from '../context'
import { openDb } from '../db/open'
import { dbPath, ensureAmtpDirs } from '../home'
import { runInit } from '../ops/init'
import { addPeer } from '../ops/peers'
import { register } from '../ops/registrations'
import { setOutputOptions } from '../output'
import { registerCardCommands } from './card'
import { captureLogs, newProgram, parseJsonLog } from './test-helpers'

let workDir: string
let home: string
let instanceId: string
let peerInstanceId: string
let originalFetch: typeof globalThis.fetch

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'amtp-card-cmd-test-'))
  home = join(workDir, 'home')
  ensureAmtpDirs(home)
  setCliHome(home)
  const init = runInit(home)
  instanceId = init.instanceId

  const db: Database = openDb(dbPath(home))
  register(db, instanceId, { handle: 'alice' })
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
  registerCardCommands(program)
  return program
}

describe('amtp card', () => {
  test('registers set/show/clear/fetch subcommands', () => {
    const program = buildProgram()
    const card = program.commands.find((c) => c.name() === 'card')
    expect(card?.commands.map((c) => c.name()).sort()).toEqual(['clear', 'fetch', 'set', 'show'])
  })

  test('set → show round-trips the signed card via the ops layer', async () => {
    const setLogs = await captureLogs(() =>
      buildProgram().parseAsync(['card', 'set', 'alice', '--name', 'Alice', '--description', 'Support'], {
        from: 'user',
      })
    )
    const signed = parseJsonLog<AmtpSignedAgentCard>(setLogs)
    expect(signed.card.name).toBe('Alice')
    expect(signed.card.description).toBe('Support')

    const showLogs = await captureLogs(() => buildProgram().parseAsync(['card', 'show', 'alice'], { from: 'user' }))
    const shown = parseJsonLog<AmtpSignedAgentCard>(showLogs)
    expect(shown).toEqual(signed)
  })

  test('show reports { card: null } when nothing is published', async () => {
    const logs = await captureLogs(() => buildProgram().parseAsync(['card', 'show', 'alice'], { from: 'user' }))
    expect(parseJsonLog<{ card: null }>(logs)).toEqual({ card: null })
  })

  // Known rough edge from ops/cards.ts: `getCard` throws a raw `JSON.parse`
  // SyntaxError on a corrupt `card_json` row. `card show` must rewrap that
  // into a clean `outputError` message, not let the raw SyntaxError escape.
  test('show reports a clean error (not a raw SyntaxError) on a corrupt card_json row', async () => {
    const db: Database = openDb(dbPath(home))
    db.run('UPDATE registrations SET card_json = ? WHERE handle = ?', ['{not valid json', 'alice'])
    db.close()

    const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
      throw new Error(`process.exit ${code}`)
    }) as typeof process.exit)
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {})

    try {
      await expect(buildProgram().parseAsync(['card', 'show', 'alice'], { from: 'user' })).rejects.toThrow(
        'process.exit 1'
      )
      expect(exitSpy).toHaveBeenCalledWith(1)
      const message = errorSpy.mock.calls[0]?.[0] as string
      // Rewrapped: our own clear prefix, not a bare raw JSON.parse SyntaxError.
      expect(message).toContain('is corrupted and could not be read')
    } finally {
      exitSpy.mockRestore()
      errorSpy.mockRestore()
    }
  })

  test('clear removes a published card', async () => {
    await captureLogs(() => buildProgram().parseAsync(['card', 'set', 'alice', '--name', 'Alice'], { from: 'user' }))
    const clearLogs = await captureLogs(() => buildProgram().parseAsync(['card', 'clear', 'alice'], { from: 'user' }))
    expect(parseJsonLog<{ handle: string; cleared: boolean }>(clearLogs)).toEqual({ handle: 'alice', cleared: true })

    const showLogs = await captureLogs(() => buildProgram().parseAsync(['card', 'show', 'alice'], { from: 'user' }))
    expect(parseJsonLog<{ card: null }>(showLogs)).toEqual({ card: null })
  })

  test('fetch verifies and prints a peer card (TOFU-pinning happy path)', async () => {
    const agentKeys = generateInstanceKeyPair()
    const sansSig = { v: 1 as const, instanceId: peerInstanceId, handle: 'bob', card: { name: 'Bob' } }
    const signedCard = { ...sansSig, cardSig: signAgentCard(agentKeys.privateKeyPem, sansSig) }

    globalThis.fetch = (async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname
      if (path.endsWith('/card')) return new Response(JSON.stringify(signedCard), { status: 200 })
      if (path.endsWith('/key'))
        return new Response(
          JSON.stringify({ handle: 'bob', instanceId: peerInstanceId, identityPublicKey: agentKeys.publicKeyPem }),
          { status: 200 }
        )
      return new Response('not found', { status: 404 })
    }) as unknown as typeof fetch

    const logs = await captureLogs(() =>
      buildProgram().parseAsync(['card', 'fetch', 'bob', '--peer', peerInstanceId], { from: 'user' })
    )
    const result = parseJsonLog<{ ok: boolean; card: { name?: string } }>(logs)
    expect(result.ok).toBe(true)
    expect(result.card.name).toBe('Bob')
  })

  test('fetch reports a clean error and exits non-zero when verification fails', async () => {
    globalThis.fetch = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch

    const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
      throw new Error(`process.exit ${code}`)
    }) as typeof process.exit)
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {})

    try {
      await expect(
        buildProgram().parseAsync(['card', 'fetch', 'bob', '--peer', peerInstanceId], { from: 'user' })
      ).rejects.toThrow('process.exit 1')
      expect(exitSpy).toHaveBeenCalledWith(1)
      expect(errorSpy).toHaveBeenCalled()
      const message = errorSpy.mock.calls[0]?.[0] as string
      expect(message).toContain('failed to fetch')
    } finally {
      exitSpy.mockRestore()
      errorSpy.mockRestore()
    }
  })
})
