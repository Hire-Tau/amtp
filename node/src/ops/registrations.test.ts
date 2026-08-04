// Spec: docs/superpowers/specs/2026-07-08-amtp-node-design.md §7.2/§9
// ("Re-run on an existing handle is an idempotent no-op ... the keypair is
// regenerated ONLY under --regenerate").

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'bun:sqlite'
import { formatAmtpAddress } from 'amtp-protocol'
import { openDb } from '../db/open'
import { dbPath, ensureAmtpDirs } from '../home'
import { getRegistration, register, setInboundOpen, validateHandle } from './registrations'

const INSTANCE_ID = 'test-instance-id'

let workDir: string
let home: string
let db: Database

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'amtp-registrations-test-'))
  home = join(workDir, 'home')
  ensureAmtpDirs(home)
  db = openDb(dbPath(home))
})

afterEach(() => {
  db.close()
  rmSync(workDir, { recursive: true, force: true })
})

describe('validateHandle', () => {
  test('accepts the AMTP.md §3 grammar', () => {
    expect(() => validateHandle('alice')).not.toThrow()
    expect(() => validateHandle('a-1_2')).not.toThrow()
  })
  test('rejects a handle starting with a symbol, containing invalid chars, or over 200 chars', () => {
    expect(() => validateHandle('-alice')).toThrow()
    expect(() => validateHandle('alice!')).toThrow()
    expect(() => validateHandle('a'.repeat(201))).toThrow()
  })
})

describe('register', () => {
  test('creates a new registration with a fresh agent keypair', () => {
    const result = register(db, INSTANCE_ID, { handle: 'alice' })

    expect(result.alreadyRegistered).toBe(false)
    expect(result.regenerated).toBe(false)
    expect(result.address).toBe(formatAmtpAddress(INSTANCE_ID, 'alice'))
    expect(result.inboundOpen).toBe(false)
    expect(result.agentPublicKeyPem).toContain('PUBLIC KEY')

    const row = getRegistration(db, 'alice')
    expect(row?.agentPublicKeyPem).toBe(result.agentPublicKeyPem)
    expect(row?.agentPrivateKeyPem).toContain('PRIVATE KEY')
  })

  test('--open sets inbound_open on a fresh registration', () => {
    const result = register(db, INSTANCE_ID, { handle: 'alice', open: true })
    expect(result.inboundOpen).toBe(true)
  })

  test('re-running on an existing handle is an idempotent no-op: same key, alreadyRegistered=true', () => {
    const first = register(db, INSTANCE_ID, { handle: 'alice' })
    const second = register(db, INSTANCE_ID, { handle: 'alice' })

    expect(second.alreadyRegistered).toBe(true)
    expect(second.regenerated).toBe(false)
    expect(second.agentPublicKeyPem).toBe(first.agentPublicKeyPem)
  })

  test('re-running still applies an --open/--close toggle even though it is otherwise a no-op', () => {
    register(db, INSTANCE_ID, { handle: 'alice' })
    const opened = register(db, INSTANCE_ID, { handle: 'alice', open: true })
    expect(opened.inboundOpen).toBe(true)
    expect(opened.alreadyRegistered).toBe(true)

    const closed = register(db, INSTANCE_ID, { handle: 'alice', open: false })
    expect(closed.inboundOpen).toBe(false)
  })

  test('--regenerate on an existing handle rotates the agent keypair and reports regenerated=true', () => {
    const first = register(db, INSTANCE_ID, { handle: 'alice' })
    const second = register(db, INSTANCE_ID, { handle: 'alice', regenerate: true })

    expect(second.alreadyRegistered).toBe(true)
    expect(second.regenerated).toBe(true)
    expect(second.agentPublicKeyPem).not.toBe(first.agentPublicKeyPem)

    const row = getRegistration(db, 'alice')
    expect(row?.agentPublicKeyPem).toBe(second.agentPublicKeyPem)
  })

  test('--regenerate preserves inboundOpen unless --open/--close is also passed', () => {
    register(db, INSTANCE_ID, { handle: 'alice', open: true })
    const regenerated = register(db, INSTANCE_ID, { handle: 'alice', regenerate: true })
    expect(regenerated.inboundOpen).toBe(true)
  })

  test('rejects an invalid handle', () => {
    expect(() => register(db, INSTANCE_ID, { handle: 'bad!handle' })).toThrow()
  })
})

describe('setInboundOpen', () => {
  test('toggles inbound_open on a registered handle', () => {
    register(db, INSTANCE_ID, { handle: 'alice' })
    setInboundOpen(db, 'alice', true)
    expect(getRegistration(db, 'alice')?.inboundOpen).toBe(true)
    setInboundOpen(db, 'alice', false)
    expect(getRegistration(db, 'alice')?.inboundOpen).toBe(false)
  })

  test('throws for an unregistered handle', () => {
    expect(() => setInboundOpen(db, 'ghost', true)).toThrow(/not registered/)
  })
})
