// §4.2 PeerStore — read-only lookup; peer CRUD is CLI-side (a later task),
// not part of this port.
//
// Spec: docs/superpowers/specs/2026-07-08-amtp-node-design.md §4.2.

import type { Database } from 'bun:sqlite'
import type { PeerStore } from 'amtp-engine'

interface PeerRow {
  base_url: string
  public_key_pem: string
  status: string
}

export function buildPeerStore(db: Database): PeerStore {
  return {
    async getPeer(instanceId) {
      const row = db
        .query<PeerRow, [string]>('SELECT base_url, public_key_pem, status FROM peers WHERE instance_id = ?')
        .get(instanceId)
      if (!row) return null
      return { baseUrl: row.base_url, publicKeyPem: row.public_key_pem, status: row.status }
    },
  }
}
