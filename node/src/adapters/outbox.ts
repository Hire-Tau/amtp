// §4.5 `outbox` (OutboxStore).
//
// Spec: docs/superpowers/specs/2026-07-08-amtp-node-design.md §4.5
// (adapter sketches) + §3.3 (backoff formula).

import { randomUUID } from 'node:crypto'
import type { Database } from 'bun:sqlite'
import type { AmtpEnvelope } from 'amtp-protocol'
import type { OutboxEntry, OutboxStore } from 'amtp-engine'

interface OutboxRow {
  id: string
  peer_instance_id: string
  to_address: string
  envelope_json: string
  attempts: number
  claim_token: string | null
}

const SELECT_COLUMNS = 'id, peer_instance_id, to_address, envelope_json, attempts, claim_token'

function toEntry(row: OutboxRow): OutboxEntry {
  return {
    id: row.id,
    peerInstanceId: row.peer_instance_id,
    toAddress: row.to_address,
    envelope: JSON.parse(row.envelope_json) as AmtpEnvelope,
    attempts: row.attempts,
    claimToken: row.claim_token,
  }
}

export function buildOutboxStore(db: Database): OutboxStore {
  const enqueueTxn = db.transaction(
    (
      id: string,
      peerInstanceId: string,
      toAddress: string,
      envelopeJson: string,
      idempotencyKey: string,
      now: number
    ): OutboxRow => {
      db.run(
        `INSERT INTO outbox (id, peer_instance_id, to_address, envelope_json, idempotency_key, status, attempts, next_attempt_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
         ON CONFLICT(idempotency_key) DO NOTHING`,
        [id, peerInstanceId, toAddress, envelopeJson, idempotencyKey, now, now, now]
      )
      const row = db
        .query<OutboxRow, [string]>(`SELECT ${SELECT_COLUMNS} FROM outbox WHERE idempotency_key = ?`)
        .get(idempotencyKey)
      // The INSERT (or its ON CONFLICT no-op onto an existing row) guarantees
      // a row exists by the time we get here.
      return row!
    }
  ).immediate

  const claimBatchTxn = db.transaction((limit: number, staleMs: number, token: string, now: number): OutboxRow[] =>
    db
      .query<OutboxRow, { $limit: number; $staleMs: number; $tok: string; $now: number }>(
        `UPDATE outbox SET status = 'delivering', claim_token = $tok, claimed_at = $now, updated_at = $now
           WHERE id IN (
             SELECT id FROM outbox
             WHERE (status = 'pending'    AND next_attempt_at <= $now)
                OR (status = 'delivering' AND claimed_at <= $now - $staleMs)
             ORDER BY next_attempt_at ASC
             LIMIT $limit
           )
           RETURNING ${SELECT_COLUMNS}`
      )
      .all({ $limit: limit, $staleMs: staleMs, $tok: token, $now: now })
  ).immediate

  return {
    async enqueue(input) {
      const now = Date.now()
      const row = enqueueTxn(
        randomUUID(),
        input.peerInstanceId,
        input.toAddress,
        JSON.stringify(input.envelope),
        input.idempotencyKey,
        now
      )
      return toEntry(row)
    },

    async claimBatch(limit, staleMs) {
      const rows = claimBatchTxn(limit, staleMs, randomUUID(), Date.now())
      return rows.map(toEntry)
    },

    async markDelivered(id, claimToken) {
      const res = db.run(
        `UPDATE outbox SET status = 'delivered', claim_token = NULL, claimed_at = NULL, last_error = NULL, updated_at = ?
         WHERE id = ? AND claim_token = ?`,
        [Date.now(), id, claimToken]
      )
      return res.changes === 1
    },

    async markRetry(id, claimToken, error) {
      const now = Date.now()
      const res = db.run(
        `UPDATE outbox SET
           status = 'pending',
           attempts = attempts + 1,
           next_attempt_at = ? + MIN(5000 * (1 << MIN(attempts + 1, 16)), 300000),
           last_error = ?, claim_token = NULL, claimed_at = NULL, updated_at = ?
         WHERE id = ? AND claim_token = ?`,
        [now, error, now, id, claimToken]
      )
      return res.changes === 1
    },

    async markFailedTerminal(id, claimToken, error) {
      const res = db.run(
        `UPDATE outbox SET status = 'failed', last_error = ?, claim_token = NULL, claimed_at = NULL, updated_at = ?
         WHERE id = ? AND claim_token = ?`,
        [error, Date.now(), id, claimToken]
      )
      return res.changes === 1
    },

    async hasOutboundAttachmentForPeer(peerInstanceId, attachmentId) {
      const row = db
        .query<{ found: number }, [string, string]>(
          `SELECT EXISTS (
             SELECT 1 FROM outbox, json_each(outbox.envelope_json, '$.attachments')
             WHERE outbox.peer_instance_id = ?
               AND json_extract(json_each.value, '$.id') = ?
           ) AS found`
        )
        .get(peerInstanceId, attachmentId)
      return !!row?.found
    },
  }
}
