import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'bun:sqlite'
import { openDb } from '../db/open'
import { dbPath, ensureAmtpDirs } from '../home'
import { listOutbox } from './outbox'

let workDir: string
let home: string
let db: Database

function seedOutboxRow(status: string, toAddress = 'amtp://x/y'): string {
  const id = randomUUID()
  const now = Date.now()
  db.run(
    `INSERT INTO outbox (id, peer_instance_id, to_address, envelope_json, idempotency_key, status, attempts, next_attempt_at, created_at, updated_at)
     VALUES (?, 'peer-x', ?, '{}', ?, ?, 0, ?, ?, ?)`,
    [id, toAddress, id, status, now, now, now]
  )
  return id
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'amtp-outbox-ops-test-'))
  home = join(workDir, 'home')
  ensureAmtpDirs(home)
  db = openDb(dbPath(home))
})

afterEach(() => {
  db.close()
  rmSync(workDir, { recursive: true, force: true })
})

describe('listOutbox', () => {
  test('lists every row when no status filter is given', () => {
    seedOutboxRow('pending')
    seedOutboxRow('failed')
    expect(listOutbox(db)).toHaveLength(2)
  })

  test('filters by status', () => {
    const pendingId = seedOutboxRow('pending')
    seedOutboxRow('failed')
    const rows = listOutbox(db, 'pending')
    expect(rows.map((r) => r.id)).toEqual([pendingId])
  })

  test('maps snake_case columns to camelCase fields', () => {
    const id = seedOutboxRow('pending', 'amtp://z/w')
    const [row] = listOutbox(db, 'pending')
    expect(row).toMatchObject({ id, toAddress: 'amtp://z/w', status: 'pending', attempts: 0 })
    expect(row.nextAttemptAt).toBeGreaterThan(0)
  })
})
