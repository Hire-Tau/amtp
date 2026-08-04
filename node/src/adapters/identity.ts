// §4.1 InstanceIdentityPort — single row in `identity`, created by `amtp init`
// (a later task). This adapter only reads.
//
// Spec: docs/superpowers/specs/2026-07-08-amtp-node-design.md §4.1.

import type { Database } from 'bun:sqlite'
import type { InstanceIdentityPort } from 'amtp-engine'

interface IdentityRow {
  instance_id: string
  public_key_pem: string
  private_key_pem: string
}

export function buildIdentityPort(db: Database): InstanceIdentityPort {
  function getRow(): IdentityRow {
    const row = db
      .query<IdentityRow, []>('SELECT instance_id, public_key_pem, private_key_pem FROM identity WHERE id = 1')
      .get()
    if (!row) throw new Error('not initialized — run amtp init')
    return row
  }

  return {
    async get() {
      const row = getRow()
      return { instanceId: row.instance_id, publicKeyPem: row.public_key_pem, privateKeyPem: row.private_key_pem }
    },
    async getSigning() {
      const row = getRow()
      return { instanceId: row.instance_id, privateKeyPem: row.private_key_pem }
    },
  }
}
