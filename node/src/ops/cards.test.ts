// Spec: docs/superpowers/specs/2026-07-08-amtp-node-design.md §4.6 (agent
// cards) — build/sign/store/clear + the handle-directory read path.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'bun:sqlite'
import { verifyAgentCard } from 'amtp-protocol'
import { buildHandleDirectory } from '../adapters/handles'
import { openDb } from '../db/open'
import { dbPath, ensureAmtpDirs } from '../home'
import { clearCard, getCard, setCard } from './cards'
import { runInit } from './init'
import { getRegistration, register } from './registrations'

let workDir: string
let home: string
let db: Database
let instanceId: string

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'amtp-cards-test-'))
  home = join(workDir, 'home')
  ensureAmtpDirs(home)
  instanceId = runInit(home).instanceId
  db = openDb(dbPath(home))
  register(db, instanceId, { handle: 'alice' })
})

afterEach(() => {
  db.close()
  rmSync(workDir, { recursive: true, force: true })
})

describe('card ops', () => {
  test('setCard signs with the handle key and stores; getCard round-trips; sig verifies', () => {
    const reg = getRegistration(db, 'alice')!
    const signed = setCard(db, instanceId, { handle: 'alice', name: 'Alice', description: 'Support' })
    expect(signed.instanceId).toBe(instanceId)
    expect(signed.handle).toBe('alice')
    expect(verifyAgentCard(reg.agentPublicKeyPem, signed)).toBe(true)
    expect(getCard(db, 'alice')).toEqual(signed)
  })

  test('setCard throws for unregistered handle; enforces caps and total size', () => {
    expect(() => setCard(db, instanceId, { handle: 'ghost', name: 'x' })).toThrow()
    expect(() => setCard(db, instanceId, { handle: 'alice', name: 'x'.repeat(201) })).toThrow()
    expect(() => setCard(db, instanceId, { handle: 'alice', extensions: { blob: 'x'.repeat(20000) } })).toThrow()
  })

  test('clearCard removes; register --regenerate clears the now-invalid card', () => {
    setCard(db, instanceId, { handle: 'alice', name: 'Alice' })
    clearCard(db, 'alice')
    expect(getCard(db, 'alice')).toBeNull()
    setCard(db, instanceId, { handle: 'alice', name: 'Alice' })
    register(db, instanceId, { handle: 'alice', regenerate: true })
    expect(getCard(db, 'alice')).toBeNull()
  })

  test('handle directory serves the card and derives list hints', async () => {
    const dir = buildHandleDirectory(db)
    expect(await dir.getCard('alice')).toBeNull()
    const signed = setCard(db, instanceId, { handle: 'alice', name: 'Alice', description: 'Support' })
    expect(await dir.getCard('alice')).toEqual(signed)
    expect(await dir.list()).toEqual([{ handle: 'alice', name: 'Alice', description: 'Support' }])
  })
})
