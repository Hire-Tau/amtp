// `amtp allow add/list/remove` (spec §7.2): receive-policy allow rules for
// closed mailboxes (§4.8's `allow_rules` table).

import { randomUUID } from 'node:crypto'
import type { Database } from 'bun:sqlite'
import { resolvePeer } from './peers'
import { getRegistration } from './registrations'

export interface AddAllowRuleArgs {
  handle: string
  peerRef: string
  /** Restrict to this remote sender handle; omit for kind 'any'. */
  senderHandle?: string
}

export interface AllowRuleRow {
  ruleId: string
  handle: string
  peerInstanceId: string
  kind: 'any' | 'handle'
  value: string | null
}

interface RawAllowRuleRow {
  id: string
  handle: string
  peer_instance_id: string
  principal_kind: 'any' | 'handle'
  principal_value: string | null
}

function fromRaw(r: RawAllowRuleRow): AllowRuleRow {
  return {
    ruleId: r.id,
    handle: r.handle,
    peerInstanceId: r.peer_instance_id,
    kind: r.principal_kind,
    value: r.principal_value,
  }
}

const SELECT_COLUMNS = 'id, handle, peer_instance_id, principal_kind, principal_value'

export function addAllowRule(db: Database, args: AddAllowRuleArgs): { ruleId: string } {
  if (!getRegistration(db, args.handle)) throw new Error(`handle not registered: ${args.handle}`)
  const peer = resolvePeer(db, args.peerRef)
  if (!peer) throw new Error(`unknown peer: ${args.peerRef}`)

  const kind: 'any' | 'handle' = args.senderHandle ? 'handle' : 'any'
  const id = randomUUID()
  db.run(
    `INSERT INTO allow_rules (id, handle, peer_instance_id, principal_kind, principal_value, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, args.handle, peer.instanceId, kind, args.senderHandle ?? null, Date.now()]
  )
  return { ruleId: id }
}

export function listAllowRules(db: Database, handle?: string): AllowRuleRow[] {
  const rows = handle
    ? db
        .query<
          RawAllowRuleRow,
          [string]
        >(`SELECT ${SELECT_COLUMNS} FROM allow_rules WHERE handle = ? ORDER BY created_at`)
        .all(handle)
    : db.query<RawAllowRuleRow, []>(`SELECT ${SELECT_COLUMNS} FROM allow_rules ORDER BY created_at`).all()
  return rows.map(fromRaw)
}

export function removeAllowRule(db: Database, ruleId: string): boolean {
  const res = db.run('DELETE FROM allow_rules WHERE id = ?', [ruleId])
  return res.changes > 0
}
