#!/usr/bin/env bun
// Standalone claimer process spawned ONLY by outbox-claim-race.test.ts's
// cross-connection race (design doc §12 carry-forward from the Task 2
// review; spec §10.4: "Claim/pin race cases additionally run
// cross-connection (two Database handles on one file) to prove the WAL
// discipline of §5.1, which the in-memory kit cannot"). Opens its OWN
// sqlite connection on the shared db file and repeatedly claims small
// batches until none remain, printing the claimed entry ids as a JSON array
// on stdout. Two of these run as real, concurrent OS processes racing over
// the SAME file — the shape an `amtp serve` drain loop racing a manual
// `amtp drain` cron invocation takes at the sqlite layer.
import { buildOutboxStore } from './adapters'
import { openDb } from './db/open'

async function main(): Promise<void> {
  const dbPath = process.argv[2]
  const batchSize = parseInt(process.argv[3] ?? '5', 10)
  if (!dbPath) throw new Error('usage: outbox-claim-race.worker.ts <dbPath> [batchSize]')

  const db = openDb(dbPath)
  try {
    const store = buildOutboxStore(db)
    const claimed: string[] = []
    for (;;) {
      const rows = await store.claimBatch(batchSize, 60_000)
      if (rows.length === 0) break
      for (const row of rows) claimed.push(row.id)
    }
    console.log(JSON.stringify(claimed))
  } finally {
    db.close()
  }
}

main()
