// Spec: docs/superpowers/specs/2026-07-08-amtp-node-design.md §5.2.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'bun:sqlite'
import { formatAmtpAddress, generateInstanceKeyPair, instanceIdFromPublicKeyPem } from 'amtp-protocol'
import { openDb } from '../db/open'
import { blobsDir, blobsTmpDir, configPath, dbPath, ensureAmtpDirs } from '../home'
import { loadServeConfig, pruneReceivedLedger, startServe, sweepOrphanBlobs, sweepTmpBlobs } from './serve'
import type { ServeHandle } from './serve'

let workDir: string
let home: string

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'amtp-serve-test-'))
  home = join(workDir, 'home')
  ensureAmtpDirs(home)
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

describe('loadServeConfig', () => {
  test('§3.4 defaults when config.json is absent', () => {
    const config = loadServeConfig(home)
    expect(config).toEqual({
      host: '0.0.0.0',
      port: 2687,
      drainIntervalMs: 5000,
      receivedRetentionMs: 3_600_000,
    })
  })

  test('reads serve.* and top-level receivedRetentionMs when present', () => {
    writeFileSync(
      configPath(home),
      JSON.stringify({
        serve: { host: '127.0.0.1', port: 9999, drainIntervalMs: 1000 },
        receivedRetentionMs: 60_000,
      })
    )
    expect(loadServeConfig(home)).toEqual({
      host: '127.0.0.1',
      port: 9999,
      drainIntervalMs: 1000,
      receivedRetentionMs: 60_000,
    })
  })

  test('falls back to defaults on malformed JSON rather than throwing', () => {
    writeFileSync(configPath(home), '{ not valid json')
    expect(loadServeConfig(home)).toEqual({
      host: '0.0.0.0',
      port: 2687,
      drainIntervalMs: 5000,
      receivedRetentionMs: 3_600_000,
    })
  })
})

describe('pruneReceivedLedger', () => {
  let db: Database

  beforeEach(() => {
    db = openDb(dbPath(home))
  })

  afterEach(() => {
    db.close()
  })

  test('deletes rows older than the retention window, keeps fresher ones', () => {
    const now = 1_000_000_000
    db.run('INSERT INTO received (peer_instance_id, envelope_id, received_at) VALUES (?, ?, ?)', [
      'peer-a',
      'old-envelope',
      now - 120_000,
    ])
    db.run('INSERT INTO received (peer_instance_id, envelope_id, received_at) VALUES (?, ?, ?)', [
      'peer-a',
      'fresh-envelope',
      now - 1000,
    ])

    const deleted = pruneReceivedLedger(db, 60_000, now)

    expect(deleted).toBe(1)
    const rows = db.query('SELECT envelope_id FROM received').all() as { envelope_id: string }[]
    expect(rows.map((r) => r.envelope_id)).toEqual(['fresh-envelope'])
  })
})

describe('sweepTmpBlobs', () => {
  test('unlinks tmp files older than 1h, keeps fresher ones', () => {
    const now = Date.now()
    const oldPath = join(blobsTmpDir(home), 'old-staged')
    const freshPath = join(blobsTmpDir(home), 'fresh-staged')
    writeFileSync(oldPath, 'x')
    writeFileSync(freshPath, 'x')
    const oldSeconds = (now - 2 * 60 * 60 * 1000) / 1000
    utimesSync(oldPath, oldSeconds, oldSeconds)

    sweepTmpBlobs(home, now)

    expect(existsSync(oldPath)).toBe(false)
    expect(existsSync(freshPath)).toBe(true)
  })
})

describe('sweepOrphanBlobs', () => {
  let db: Database

  beforeEach(() => {
    db = openDb(dbPath(home))
  })

  afterEach(() => {
    db.close()
  })

  test('unlinks an old file with no matching attachments row, keeps a referenced one and a fresh orphan', () => {
    const now = Date.now()
    const oldOrphanId = 'old-orphan'
    const freshOrphanId = 'fresh-orphan'
    const referencedId = 'referenced'

    for (const id of [oldOrphanId, freshOrphanId, referencedId]) {
      writeFileSync(join(blobsDir(home), id), 'blob-bytes')
    }
    const oldSeconds = (now - 2 * 60 * 60 * 1000) / 1000
    utimesSync(join(blobsDir(home), oldOrphanId), oldSeconds, oldSeconds)
    utimesSync(join(blobsDir(home), referencedId), oldSeconds, oldSeconds)

    db.run(
      `INSERT INTO registrations (handle, inbound_open, agent_public_key_pem, agent_private_key_pem, created_at)
       VALUES ('h', 0, 'pub', 'priv', ?)`,
      [now]
    )
    db.run(
      `INSERT INTO attachments (id, message_id, direction, filename, content_type, byte_size, sha256, storage_path, created_at)
       VALUES (?, NULL, 'out', 'f', 'application/octet-stream', 1, 'sha', ?, ?)`,
      [randomUUID(), referencedId, now]
    )

    sweepOrphanBlobs(db, home, now)

    expect(existsSync(join(blobsDir(home), oldOrphanId))).toBe(false)
    expect(existsSync(join(blobsDir(home), freshOrphanId))).toBe(true)
    expect(existsSync(join(blobsDir(home), referencedId))).toBe(true)
  })

  test('never descends into blobs/tmp/', () => {
    writeFileSync(join(blobsTmpDir(home), 'staged'), 'x')
    const oldSeconds = (Date.now() - 2 * 60 * 60 * 1000) / 1000
    utimesSync(join(blobsTmpDir(home), 'staged'), oldSeconds, oldSeconds)

    sweepOrphanBlobs(db, home, Date.now())

    expect(existsSync(join(blobsTmpDir(home), 'staged'))).toBe(true)
  })
})

describe('startServe', () => {
  let handle: ServeHandle | undefined
  let logLines: string[]
  let originalLog: typeof console.log

  beforeEach(() => {
    const db = openDb(dbPath(home))
    const keys = generateInstanceKeyPair()
    db.run(
      'INSERT INTO identity (id, instance_id, public_key_pem, private_key_pem, created_at) VALUES (1, ?, ?, ?, ?)',
      [instanceIdFromPublicKeyPem(keys.publicKeyPem), keys.publicKeyPem, keys.privateKeyPem, Date.now()]
    )
    db.close()

    logLines = []
    originalLog = console.log
    console.log = (line: string) => {
      logLines.push(line)
    }
  })

  afterEach(async () => {
    console.log = originalLog
    if (handle) {
      await handle.stop()
      handle = undefined
    }
  })

  test('binds an ephemeral port, prints the machine-parseable listening line, serves /healthz, then stops cleanly', async () => {
    handle = await startServe({ home, hostOverride: '127.0.0.1', portOverride: 0 })

    expect(logLines.length).toBe(1)
    const printed = JSON.parse(logLines[0]) as { listening: boolean; host: string; port: number; instanceId: string }
    expect(printed.listening).toBe(true)
    expect(printed.host).toBe('127.0.0.1')
    expect(printed.port).toBe(handle.server.port as number)
    expect(typeof printed.instanceId).toBe('string')

    const res = await fetch(`http://127.0.0.1:${handle.server.port}/healthz`)
    expect(res.status).toBe(200)

    await handle.stop()
    // A second stop() must be a no-op, not a double-close throw.
    await handle.stop()

    await expect(fetch(`http://127.0.0.1:${handle.server.port}/healthz`)).rejects.toThrow()
    handle = undefined
  })

  test('the drain loop invokes drainOutboxOnce on its own schedule (no CLI/manual trigger)', async () => {
    // A pending outbox row addressed to an unreachable peer: the drain loop
    // firing at least once is observable as attempts incrementing (a failed
    // delivery is retried, per the engine's outbox backoff), proving the
    // periodic timer — not test code — invoked engine.drainOutboxOnce().
    const db = openDb(dbPath(home))
    db.run(
      `INSERT INTO peers (instance_id, alias, base_url, public_key_pem, status, created_at)
       VALUES ('unreachable-peer', 'u', 'http://127.0.0.1:1', 'unused', 'active', ?)`,
      [Date.now()]
    )
    const outboxId = randomUUID()
    db.run(
      `INSERT INTO outbox (id, peer_instance_id, to_address, envelope_json, idempotency_key, status, attempts, next_attempt_at, created_at, updated_at)
       VALUES (?, 'unreachable-peer', ?, ?, ?, 'pending', 0, 0, ?, ?)`,
      [
        outboxId,
        formatAmtpAddress('unreachable-peer', 'bob'),
        JSON.stringify({
          v: 1,
          id: randomUUID(),
          ts: Date.now(),
          from: 'amtp://us/alice',
          to: formatAmtpAddress('unreachable-peer', 'bob'),
          content: 'hi',
        }),
        randomUUID(),
        Date.now(),
        Date.now(),
      ]
    )
    db.close()

    handle = await startServe({ home, hostOverride: '127.0.0.1', portOverride: 0 })
    // drainIntervalMs default is 5000ms in production config; override via a
    // fresh config.json is not read after startup, so instead assert on the
    // FIRST maintenance-independent behavior directly reachable within a
    // reasonable wait: startServe's drain loop uses config.drainIntervalMs
    // from config.json, which is absent here (default 5000ms) — poll up to
    // one interval plus margin.
    const deadline = Date.now() + 6000
    let attempts = 0
    while (Date.now() < deadline) {
      const row = handle.db.query('SELECT attempts FROM outbox WHERE id = ?').get(outboxId) as {
        attempts: number
      } | null
      attempts = row?.attempts ?? 0
      if (attempts > 0) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    expect(attempts).toBeGreaterThan(0)
  }, 10000)
})
