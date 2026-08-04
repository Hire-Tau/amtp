// `amtp peer add/list/remove` (spec §7.2). Peer CRUD is CLI-side, not an
// engine port (§4.2) — this module owns the `peers` table directly.

import type { Database } from 'bun:sqlite'
import { instanceIdFromPublicKeyPem } from 'amtp-protocol'

export interface PeerRow {
  instanceId: string
  alias: string
  baseUrl: string
  publicKeyPem: string
  status: string
}

interface RawPeerRow {
  instance_id: string
  alias: string
  base_url: string
  public_key_pem: string
  status: string
}

function fromRaw(r: RawPeerRow): PeerRow {
  return {
    instanceId: r.instance_id,
    alias: r.alias,
    baseUrl: r.base_url,
    publicKeyPem: r.public_key_pem,
    status: r.status,
  }
}

const SELECT_COLUMNS = 'instance_id, alias, base_url, public_key_pem, status'

export interface AddPeerArgs {
  alias: string
  baseUrl: string
  publicKeyPem: string
  /** If given, MUST match the instance id that `publicKeyPem` derives (AMTP.md §4.2 self-certification). */
  instanceId?: string
}

export function addPeer(db: Database, args: AddPeerArgs): PeerRow {
  const derivedInstanceId = instanceIdFromPublicKeyPem(args.publicKeyPem)
  if (args.instanceId && args.instanceId !== derivedInstanceId) {
    throw new Error(
      `--instance-id ${args.instanceId} does not match the instance id derived from --public-key (${derivedInstanceId})`
    )
  }
  db.run(
    `INSERT INTO peers (instance_id, alias, base_url, public_key_pem, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)`,
    [derivedInstanceId, args.alias, args.baseUrl, args.publicKeyPem, Date.now()]
  )
  return {
    instanceId: derivedInstanceId,
    alias: args.alias,
    baseUrl: args.baseUrl,
    publicKeyPem: args.publicKeyPem,
    status: 'active',
  }
}

export function listPeers(db: Database): PeerRow[] {
  const rows = db.query<RawPeerRow, []>(`SELECT ${SELECT_COLUMNS} FROM peers ORDER BY alias`).all()
  return rows.map(fromRaw)
}

/** Resolve a peer by alias OR instance id (§7.2: "<ref> (alias or instanceId)"). */
export function resolvePeer(db: Database, ref: string): PeerRow | null {
  const row = db
    .query<RawPeerRow, [string, string]>(`SELECT ${SELECT_COLUMNS} FROM peers WHERE alias = ? OR instance_id = ?`)
    .get(ref, ref)
  return row ? fromRaw(row) : null
}

export function removePeer(db: Database, ref: string): boolean {
  const res = db.run('DELETE FROM peers WHERE alias = ? OR instance_id = ?', [ref, ref])
  return res.changes > 0
}
