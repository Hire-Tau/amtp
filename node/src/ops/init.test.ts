// Spec: docs/superpowers/specs/2026-07-08-amtp-node-design.md §7.2 (`amtp init`).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { instanceIdFromPublicKeyPem } from 'amtp-protocol'
import { openDb } from '../db/open'
import { configPath, dbPath } from '../home'
import { runInit } from './init'

let workDir: string
let home: string

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'amtp-init-test-'))
  home = join(workDir, 'home')
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

describe('runInit', () => {
  test('creates the db + identity row + config.json on a fresh home', () => {
    const result = runInit(home)

    expect(result.alreadyInitialized).toBe(false)
    expect(result.instanceId).toBe(instanceIdFromPublicKeyPem(result.publicKeyPem))
    expect(existsSync(dbPath(home))).toBe(true)
    expect(existsSync(configPath(home))).toBe(true)

    // The identity is durably persisted, independent of runInit's own process state.
    const db = openDb(dbPath(home))
    try {
      const row = db
        .query<
          { instance_id: string; public_key_pem: string; private_key_pem: string },
          []
        >('SELECT instance_id, public_key_pem, private_key_pem FROM identity WHERE id = 1')
        .get()
      expect(row?.instance_id).toBe(result.instanceId)
      expect(row?.public_key_pem).toBe(result.publicKeyPem)
      expect(row?.private_key_pem).toContain('PRIVATE KEY')
    } finally {
      db.close()
    }
  })

  test('sets 0700 on the home dir and 0600 on the db file', () => {
    runInit(home)
    expect(statSync(home).mode & 0o777).toBe(0o700)
    expect(statSync(dbPath(home)).mode & 0o777).toBe(0o600)
  })

  test('is idempotent: re-running returns the SAME identity and does not change it', () => {
    const first = runInit(home)
    const second = runInit(home)

    expect(second.alreadyInitialized).toBe(true)
    expect(second.instanceId).toBe(first.instanceId)
    expect(second.publicKeyPem).toBe(first.publicKeyPem)
  })

  test('does not overwrite an existing config.json on re-init', () => {
    runInit(home)
    const before = statSync(configPath(home)).mtimeMs
    runInit(home)
    expect(statSync(configPath(home)).mtimeMs).toBe(before)
  })
})
