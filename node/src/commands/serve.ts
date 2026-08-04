// `amtp serve`: opens the home/db, builds the engine, starts the HTTP
// receive host (../http.ts), and runs the outbox drain loop + periodic
// maintenance sweep alongside it — all inside one process (spec §5.2).
//
// This module exposes `startServe`, the testable unit: it does NOT call
// `process.exit` itself. Wiring it to `process.on('SIGINT'/'SIGTERM', …)` and
// exiting the process is the CLI entrypoint's job (a later task); this
// module only registers the handlers and exposes an explicit `stop()` so
// both paths (a real signal, or a caller invoking `stop()` directly) run the
// exact same shutdown sequence.
//
// Spec: docs/superpowers/specs/2026-07-08-amtp-node-design.md §5.2.

import { readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { Database } from 'bun:sqlite'
import { OUTBOX_DEFAULT_BATCH_SIZE } from 'amtp-engine'
import { openDb } from '../db/open'
import { buildNodeEngine } from '../engine'
import { blobsDir, blobsTmpDir, configPath, dbPath, ensureAmtpDirs } from '../home'
import { buildServer } from '../http'

// §3.4 defaults (mirrors src/adapters/policy.ts's own default constants —
// this is a SEPARATE config section, `serve.*` / top-level
// `receivedRetentionMs`, not `receive.*`).
const DEFAULT_HOST = '0.0.0.0'
const DEFAULT_PORT = 2687
const DEFAULT_DRAIN_INTERVAL_MS = 5000
const DEFAULT_RECEIVED_RETENTION_MS = 3_600_000 // 60 min, §3.4

const MAINTENANCE_INTERVAL_MS = 10 * 60 * 1000 // §5.2: "startup + every 10 minutes"
const BLOB_SWEEP_AGE_MS = 60 * 60 * 1000 // §5.2/§3.3: "older than 1 h"
const MAX_CONSECUTIVE_DRAINS = 10 // §5.2 loop-until-empty bound

export interface ServeConfig {
  host: string
  port: number
  drainIntervalMs: number
  receivedRetentionMs: number
}

/**
 * Read `serve.*` + `receivedRetentionMs` out of `config.json`, falling back
 * to the §3.4 defaults for anything missing, malformed, or absent (there is
 * no `amtp init`-created config.json in every test/dev home, so this must
 * never throw).
 */
export function loadServeConfig(home: string): ServeConfig {
  let parsed: {
    serve?: { host?: unknown; port?: unknown; drainIntervalMs?: unknown }
    receivedRetentionMs?: unknown
  } = {}
  try {
    parsed = JSON.parse(readFileSync(configPath(home), 'utf8'))
  } catch {
    parsed = {}
  }
  const serve = parsed.serve ?? {}
  return {
    host: typeof serve.host === 'string' ? serve.host : DEFAULT_HOST,
    port: typeof serve.port === 'number' ? serve.port : DEFAULT_PORT,
    drainIntervalMs: typeof serve.drainIntervalMs === 'number' ? serve.drainIntervalMs : DEFAULT_DRAIN_INTERVAL_MS,
    receivedRetentionMs:
      typeof parsed.receivedRetentionMs === 'number' ? parsed.receivedRetentionMs : DEFAULT_RECEIVED_RETENTION_MS,
  }
}

/** Prune `received` (replay ledger) rows older than `retentionMs` (§5.2). Returns the row count deleted. */
export function pruneReceivedLedger(db: Database, retentionMs: number, now: number): number {
  const cutoff = now - retentionMs
  return db.run('DELETE FROM received WHERE received_at < ?', [cutoff]).changes
}

/** Sweep `blobs/tmp/*` staging files older than 1 h — crash residue from an interrupted write (§3.3/§5.2). */
export function sweepTmpBlobs(home: string, now: number): void {
  const dir = blobsTmpDir(home)
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    const path = join(dir, name)
    try {
      if (now - statSync(path).mtimeMs > BLOB_SWEEP_AGE_MS) unlinkSync(path)
    } catch {
      // best-effort — a concurrent unlink or permission hiccup is not fatal.
    }
  }
}

/**
 * Sweep `blobs/*` files (excluding `tmp/`) with no `attachments.storage_path`
 * row, older than 1 h — a crash between rename and sqlite commit orphans
 * exactly this shape of file (§3.3/§5.2).
 */
export function sweepOrphanBlobs(db: Database, home: string, now: number): void {
  const dir = blobsDir(home)
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    if (name === 'tmp') continue
    const path = join(dir, name)
    try {
      const stat = statSync(path)
      if (!stat.isFile()) continue
      if (now - stat.mtimeMs <= BLOB_SWEEP_AGE_MS) continue
      const row = db.query('SELECT 1 FROM attachments WHERE storage_path = ?').get(name)
      if (!row) unlinkSync(path)
    } catch {
      // best-effort
    }
  }
}

/** Run the full §5.2 maintenance sweep once (called at startup, then every `MAINTENANCE_INTERVAL_MS`). */
export function runMaintenance(db: Database, home: string, receivedRetentionMs: number, now: number): void {
  pruneReceivedLedger(db, receivedRetentionMs, now)
  sweepTmpBlobs(home, now)
  sweepOrphanBlobs(db, home, now)
}

export interface ServeOptions {
  home: string
  /** Flags > config.json > defaults (spec §11). */
  hostOverride?: string
  portOverride?: number
  /** Default: stderr `[amtp] level message` lines (spec §4). */
  logger?: (level: 'info' | 'warn', message: string) => void
}

export interface ServeHandle {
  server: ReturnType<typeof buildServer>
  db: Database
  config: ServeConfig
  /** Idempotent: stops the drain/maintenance timers, waits for an in-flight
   *  drain to finish, stops the HTTP server, and closes the db (spec §5.2). */
  stop: () => Promise<void>
}

/**
 * Start `amtp serve`: open the db, build the engine, bind the HTTP host, and
 * run the drain + maintenance loops. Prints the machine-parseable
 * `{"listening": …}` line to stdout once bound (spec §5.2) and registers
 * SIGINT/SIGTERM handlers that run the SAME shutdown sequence `stop()`
 * exposes, then `process.exit(0)`.
 */
export async function startServe(opts: ServeOptions): Promise<ServeHandle> {
  const { home } = opts
  ensureAmtpDirs(home)
  const db = openDb(dbPath(home))
  const config = loadServeConfig(home)
  const host = opts.hostOverride ?? config.host
  const port = opts.portOverride ?? config.port

  const logger =
    opts.logger ??
    ((level: 'info' | 'warn', message: string) => {
      process.stderr.write(`[amtp] ${level} ${message}\n`)
    })

  const engine = buildNodeEngine(db, home, { logger })
  const server = buildServer(engine, { hostname: host, port })

  // Startup maintenance sweep, then every 10 minutes (§5.2).
  runMaintenance(db, home, config.receivedRetentionMs, Date.now())
  const maintenanceTimer = setInterval(
    () => runMaintenance(db, home, config.receivedRetentionMs, Date.now()),
    MAINTENANCE_INTERVAL_MS
  )

  // Drain scheduling: non-reentrant guard (skip a tick while a drain is in
  // flight) + loop-until-empty refinement (a full batch means more work may
  // be waiting, so drain again immediately, bounded).
  let draining = false
  const runDrainBurst = async (): Promise<void> => {
    if (draining) return
    draining = true
    try {
      for (let i = 0; i < MAX_CONSECUTIVE_DRAINS; i++) {
        const result = await engine.drainOutboxOnce({ batchSize: OUTBOX_DEFAULT_BATCH_SIZE })
        const claimed = result.delivered + result.retried + result.failedTerminal
        if (claimed < OUTBOX_DEFAULT_BATCH_SIZE) break
      }
    } catch (err) {
      logger('warn', `outbox drain tick failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      draining = false
    }
  }
  const drainTimer = setInterval(() => {
    void runDrainBurst()
  }, config.drainIntervalMs)

  const { instanceId } = await engine.getIdentity()
  console.log(JSON.stringify({ listening: true, host, port: server.port, instanceId }))

  let stopped = false
  const stop = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    process.removeListener('SIGINT', onSignal)
    process.removeListener('SIGTERM', onSignal)
    clearInterval(drainTimer)
    clearInterval(maintenanceTimer)
    // Let an in-flight drain finish rather than tearing it down mid-write
    // (a hard kill instead of this graceful path is covered by the claim
    // token's stale-reclaim, per §5.2).
    while (draining) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    server.stop()
    db.close()
  }

  const onSignal = (): void => {
    void stop().then(() => process.exit(0))
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)

  return { server, db, config, stop }
}
