// `amtp outbox list` (spec §7.2): dead-letter visibility over the outbox
// table. `amtp drain` calls `engine.drainOutboxOnce()` directly (no ops
// wrapper needed — it's a single engine call).

import type { Database } from 'bun:sqlite'

export interface OutboxRowSummary {
  id: string
  toAddress: string
  status: string
  attempts: number
  nextAttemptAt: number
  lastError: string | null
}

interface RawOutboxRow {
  id: string
  to_address: string
  status: string
  attempts: number
  next_attempt_at: number
  last_error: string | null
}

const SELECT_COLUMNS = 'id, to_address, status, attempts, next_attempt_at, last_error'

export function listOutbox(db: Database, status?: string): OutboxRowSummary[] {
  const rows = status
    ? db
        .query<RawOutboxRow, [string]>(`SELECT ${SELECT_COLUMNS} FROM outbox WHERE status = ? ORDER BY next_attempt_at`)
        .all(status)
    : db.query<RawOutboxRow, []>(`SELECT ${SELECT_COLUMNS} FROM outbox ORDER BY next_attempt_at`).all()
  return rows.map((r) => ({
    id: r.id,
    toAddress: r.to_address,
    status: r.status,
    attempts: r.attempts,
    nextAttemptAt: r.next_attempt_at,
    lastError: r.last_error,
  }))
}
