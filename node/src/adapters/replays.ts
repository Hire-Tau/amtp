// §4.4 `replays` (ReplayLedger) — a single atomic INSERT OR IGNORE for
// `recordIfNew` (its `.changes` tells us whether this call actually inserted
// the row); `unrecord` is an idempotent DELETE.
//
// Spec: docs/superpowers/specs/2026-07-08-amtp-node-design.md §4.4.

import type { Database } from 'bun:sqlite'
import type { ReplayLedger } from 'amtp-engine'

export function buildReplayLedger(db: Database): ReplayLedger {
  return {
    async recordIfNew(peerInstanceId, envelopeId) {
      const res = db.run(
        'INSERT OR IGNORE INTO received (peer_instance_id, envelope_id, received_at) VALUES (?, ?, ?)',
        [peerInstanceId, envelopeId, Date.now()]
      )
      return res.changes === 1
    },
    async unrecord(peerInstanceId, envelopeId) {
      db.run('DELETE FROM received WHERE peer_instance_id = ? AND envelope_id = ?', [peerInstanceId, envelopeId])
    },
  }
}
