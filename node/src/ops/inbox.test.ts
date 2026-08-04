// Spec: docs/superpowers/specs/2026-07-08-amtp-node-design.md §7.2, §8.2
// (cursor keyed (received_at, id)).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'bun:sqlite'
import { openDb } from '../db/open'
import { dbPath, ensureAmtpDirs } from '../home'
import { runInit } from './init'
import { register } from './registrations'
import { listInbox, readMessage } from './inbox'

let workDir: string
let home: string
let db: Database

function seedMessage(opts: {
  id?: string
  kind?: 'received' | 'bounce'
  handle: string
  from?: string
  subject?: string | null
  content?: string
  receivedAt: number
  envelopeId?: string | null
  readAt?: number | null
  bounceJson?: string | null
}): string {
  const id = opts.id ?? randomUUID()
  db.run(
    `INSERT INTO messages (id, kind, handle, from_address, envelope_id, subject, content, bounce_json, received_at, read_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      opts.kind ?? 'received',
      opts.handle,
      opts.from ?? 'amtp://remote-instance/bob',
      opts.envelopeId ?? randomUUID(),
      opts.subject ?? null,
      opts.content ?? 'hello',
      opts.bounceJson ?? null,
      opts.receivedAt,
      opts.readAt ?? null,
    ]
  )
  return id
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'amtp-inbox-test-'))
  home = join(workDir, 'home')
  ensureAmtpDirs(home)
  const init = runInit(home)
  db = openDb(dbPath(home))
  register(db, init.instanceId, { handle: 'alice' })
  register(db, init.instanceId, { handle: 'carol' })
})

afterEach(() => {
  db.close()
  rmSync(workDir, { recursive: true, force: true })
})

describe('listInbox', () => {
  test('orders newest-first by (received_at, id)', () => {
    const older = seedMessage({ handle: 'alice', receivedAt: 1000 })
    const newer = seedMessage({ handle: 'alice', receivedAt: 2000 })
    expect(listInbox(db).map((m) => m.id)).toEqual([newer, older])
  })

  test('tiebreaks equal received_at by id descending (stable pagination key)', () => {
    const a = seedMessage({ id: 'aaaa', handle: 'alice', receivedAt: 5000 })
    const b = seedMessage({ id: 'bbbb', handle: 'alice', receivedAt: 5000 })
    expect(listInbox(db).map((m) => m.id)).toEqual([b, a])
  })

  test('filters by handle', () => {
    seedMessage({ handle: 'alice', receivedAt: 1000 })
    const carolMsg = seedMessage({ handle: 'carol', receivedAt: 2000 })
    expect(listInbox(db, { handle: 'carol' }).map((m) => m.id)).toEqual([carolMsg])
  })

  test('unreadOnly excludes read messages', () => {
    const unread = seedMessage({ handle: 'alice', receivedAt: 1000, readAt: null })
    seedMessage({ handle: 'alice', receivedAt: 2000, readAt: 1500 })
    expect(listInbox(db, { unreadOnly: true }).map((m) => m.id)).toEqual([unread])
  })

  test('limit caps the result count', () => {
    seedMessage({ handle: 'alice', receivedAt: 1000 })
    seedMessage({ handle: 'alice', receivedAt: 2000 })
    expect(listInbox(db, { limit: 1 })).toHaveLength(1)
  })

  test('before cursor returns only strictly-older-than-(received_at,id) rows', () => {
    const a = seedMessage({ id: 'a-msg', handle: 'alice', receivedAt: 1000 })
    const b = seedMessage({ id: 'b-msg', handle: 'alice', receivedAt: 2000 })
    seedMessage({ id: 'c-msg', handle: 'alice', receivedAt: 3000 })

    const page = listInbox(db, { before: { receivedAt: 3000, id: 'c-msg' } })
    expect(page.map((m) => m.id)).toEqual([b, a])
  })

  test('reports attachmentCount and read flag', () => {
    const id = seedMessage({ handle: 'alice', receivedAt: 1000, readAt: 1500 })
    db.run(
      `INSERT INTO attachments (id, message_id, direction, filename, content_type, byte_size, sha256, storage_path, created_at)
       VALUES (?, ?, 'in', 'a.txt', 'text/plain', 3, 'deadbeef', ?, ?)`,
      [randomUUID(), id, randomUUID(), Date.now()]
    )
    const [summary] = listInbox(db)
    expect(summary.attachmentCount).toBe(1)
    expect(summary.read).toBe(true)
  })
})

describe('readMessage', () => {
  test('returns the full message and marks it read', () => {
    const id = seedMessage({ handle: 'alice', receivedAt: 1000, subject: 'hi', content: 'body text' })
    const message = readMessage(db, id)

    expect(message.subject).toBe('hi')
    expect(message.content).toBe('body text')
    expect(message.read).toBe(true)
    expect(listInbox(db, { unreadOnly: true })).toHaveLength(0)
  })

  test('--keep-unread leaves an unread message unread', () => {
    const id = seedMessage({ handle: 'alice', receivedAt: 1000 })
    readMessage(db, id, { keepUnread: true })
    expect(listInbox(db, { unreadOnly: true }).map((m) => m.id)).toEqual([id])
  })

  test('surfaces agentSigVerified (AMTP.md §4.5 MUST-surface)', () => {
    const id = seedMessage({ handle: 'alice', receivedAt: 1000 })
    db.run('UPDATE messages SET agent_sig_verified = 1 WHERE id = ?', [id])
    expect(readMessage(db, id).agentSigVerified).toBe(true)
  })

  test('surfaces bounce metadata for a bounce message', () => {
    const id = seedMessage({
      handle: 'alice',
      kind: 'bounce',
      from: 'system',
      receivedAt: 1000,
      bounceJson: JSON.stringify({
        outboxId: 'ob-1',
        envelopeId: 'env-1',
        toAddress: 'amtp://x/y',
        reason: 'HTTP 404',
      }),
    })
    const message = readMessage(db, id)
    expect(message.kind).toBe('bounce')
    expect(message.bounce).toEqual({
      outboxId: 'ob-1',
      envelopeId: 'env-1',
      toAddress: 'amtp://x/y',
      reason: 'HTTP 404',
    })
  })

  test('throws for an unknown message id', () => {
    expect(() => readMessage(db, 'ghost')).toThrow(/unknown message/)
  })
})
