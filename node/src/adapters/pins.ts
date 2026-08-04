// §4.3 PinStore (TOFU) — first-write-wins, race-safe via a single
// `BEGIN IMMEDIATE` transaction: INSERT OR IGNORE then SELECT the winning
// row (whether or not this call's INSERT actually won).
//
// Spec: docs/superpowers/specs/2026-07-08-amtp-node-design.md §4.3.

import type { Database } from 'bun:sqlite'
import type { PinStore } from 'amtp-engine'

export function buildPinStore(db: Database): PinStore {
  const recordIfNew = db.transaction((peerInstanceId: string, handle: string, publicKeyPem: string, now: number) => {
    db.run('INSERT OR IGNORE INTO pins (peer_instance_id, handle, public_key_pem, created_at) VALUES (?, ?, ?, ?)', [
      peerInstanceId,
      handle,
      publicKeyPem,
      now,
    ])
    const row = db
      .query<
        { public_key_pem: string },
        [string, string]
      >('SELECT public_key_pem FROM pins WHERE peer_instance_id = ? AND handle = ?')
      .get(peerInstanceId, handle)
    // The INSERT OR IGNORE above guarantees a row exists by the time we get here.
    return row!.public_key_pem
  }).immediate

  return {
    async getPin(peerInstanceId, handle) {
      const row = db
        .query<
          { public_key_pem: string },
          [string, string]
        >('SELECT public_key_pem FROM pins WHERE peer_instance_id = ? AND handle = ?')
        .get(peerInstanceId, handle)
      return row ? row.public_key_pem : null
    },
    async recordPinIfNew(peerInstanceId, handle, publicKeyPem) {
      return recordIfNew(peerInstanceId, handle, publicKeyPem, Date.now())
    },
  }
}
