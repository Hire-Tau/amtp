// Cross-connection OutboxStore.claimBatch race (design doc §12 carry-forward
// from the Task 2 review; spec §10.4: "Claim/pin race cases additionally run
// cross-connection (two Database handles on one file) to prove the WAL
// discipline of §5.1, which the in-memory kit cannot"). Spawns TWO real
// subprocesses (./outbox-claim-race.worker.ts), each opening its own sqlite
// connection on the SAME db file and racing to claim the same pending rows —
// genuine OS-level concurrency, not two JS objects cooperatively
// interleaved on one thread (bun:sqlite calls are synchronous, so two
// `Database` handles in a single process could never actually overlap).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'bun:sqlite'
import type { AmtpEnvelope } from 'amtp-protocol'
import { buildOutboxStore } from './adapters'
import { openDb } from './db/open'
import { ensureAmtpDirs } from './home'

const WORKER_ENTRY = join(import.meta.dir, 'outbox-claim-race.worker.ts')

let workDir: string
let dbPath: string
let db: Database

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'amtp-outbox-race-'))
  ensureAmtpDirs(join(workDir, 'home'))
  dbPath = join(workDir, 'amtp.db')
  db = openDb(dbPath)
})

afterEach(() => {
  db.close()
  rmSync(workDir, { recursive: true, force: true })
})

/** Spawn one claimer subprocess and collect the ids it claimed. */
async function runClaimer(): Promise<string[]> {
  const proc = Bun.spawn(['bun', 'run', WORKER_ENTRY, dbPath, '5'], { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (exitCode !== 0) throw new Error(`claimer subprocess failed (exit ${exitCode}): ${stderr}`)
  return JSON.parse(stdout) as string[]
}

describe('OutboxStore.claimBatch — cross-connection race', () => {
  test('two real subprocesses racing claimBatch over the same pending rows claim disjoint sets, nothing lost or doubled', async () => {
    const store = buildOutboxStore(db)
    const TOTAL = 40
    const seededIds: string[] = []
    for (let i = 0; i < TOTAL; i++) {
      const envelope: AmtpEnvelope = {
        v: 1,
        id: randomUUID(),
        ts: Date.now(),
        from: 'amtp://local/me',
        to: 'amtp://race-peer/someone',
        content: `msg ${i}`,
      }
      const entry = await store.enqueue({
        peerInstanceId: 'race-peer',
        toAddress: 'amtp://race-peer/someone',
        envelope,
        idempotencyKey: randomUUID(),
      })
      seededIds.push(entry.id)
    }

    // Spawn BOTH before awaiting either — real, concurrent OS processes
    // racing over the same on-disk file.
    const [claimedA, claimedB] = await Promise.all([runClaimer(), runClaimer()])

    const combined = [...claimedA, ...claimedB]
    const asSet = new Set(combined)
    expect(asSet.size).toBe(combined.length) // no id claimed by both connections
    expect(combined.length).toBe(TOTAL) // nothing lost to the race
    for (const id of seededIds) expect(asSet.has(id)).toBe(true)
  }, 20_000)
})
