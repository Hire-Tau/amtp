// `amtp identity` / `amtp whoami` (spec §7.2).

import type { Database } from 'bun:sqlite'
import { formatAmtpAddress } from 'amtp-protocol'

export interface IdentityInfo {
  instanceId: string
  publicKeyPem: string
}

export function getIdentity(db: Database): IdentityInfo {
  const row = db
    .query<
      { instance_id: string; public_key_pem: string },
      []
    >('SELECT instance_id, public_key_pem FROM identity WHERE id = 1')
    .get()
  if (!row) throw new Error('not initialized — run amtp init')
  return { instanceId: row.instance_id, publicKeyPem: row.public_key_pem }
}

export interface WhoamiRegistration {
  handle: string
  address: string
  inboundOpen: boolean
  agentPublicKeyPem: string
  /** The handle's published card's display name, when a card is published (spec §4.6). */
  name?: string
}

export interface WhoamiResult {
  instanceId: string
  registrations: WhoamiRegistration[]
}

/** Pull just `card.name` out of a (possibly corrupt) `card_json` row — degrades
 *  to `undefined` on a parse failure rather than throwing, mirroring
 *  `adapters/handles.ts`'s `parseCard` (a bad row must never break `whoami`
 *  for the whole instance). */
function cardName(cardJson: string | null): string | undefined {
  if (!cardJson) return undefined
  try {
    const parsed = JSON.parse(cardJson) as { card?: { name?: unknown } }
    return typeof parsed.card?.name === 'string' ? parsed.card.name : undefined
  } catch {
    return undefined
  }
}

export function getWhoami(db: Database): WhoamiResult {
  const identity = getIdentity(db)
  const rows = db
    .query<
      { handle: string; inbound_open: number; agent_public_key_pem: string; card_json: string | null },
      []
    >('SELECT handle, inbound_open, agent_public_key_pem, card_json FROM registrations ORDER BY handle')
    .all()
  return {
    instanceId: identity.instanceId,
    registrations: rows.map((r) => {
      const reg: WhoamiRegistration = {
        handle: r.handle,
        address: formatAmtpAddress(identity.instanceId, r.handle),
        inboundOpen: !!r.inbound_open,
        agentPublicKeyPem: r.agent_public_key_pem,
      }
      const name = cardName(r.card_json)
      if (name !== undefined) reg.name = name
      return reg
    }),
  }
}
