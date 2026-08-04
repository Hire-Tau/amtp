// §4.7 `handles` (HandleDirectory) — `recipientRef` IS the handle for this
// host (a node has no separate agent-id concept the way a multi-agent host does).
//
// Spec: docs/superpowers/specs/2026-07-08-amtp-node-design.md §4.7.

import type { Database } from 'bun:sqlite'
import type { HandleDirectory, HandleListing } from 'amtp-engine'
import type { AmtpSignedAgentCard } from 'amtp-protocol'

interface RegistrationRow {
  handle: string
  inbound_open: number
  agent_public_key_pem: string
}

interface CardRow {
  handle: string
  card_json: string | null
}

/** Parse `card_json`, degrading a corrupt row to `null` rather than throwing
 *  (a bad row must never break resolve/list/getCard for the whole directory). */
function parseCard(cardJson: string | null): AmtpSignedAgentCard | null {
  if (!cardJson) return null
  try {
    return JSON.parse(cardJson) as AmtpSignedAgentCard
  } catch {
    return null
  }
}

export function buildHandleDirectory(db: Database): HandleDirectory {
  return {
    async resolve(handle) {
      const row = db
        .query<
          RegistrationRow,
          [string]
        >('SELECT handle, inbound_open, agent_public_key_pem FROM registrations WHERE handle = ?')
        .get(handle)
      if (!row) return null
      return { recipientRef: row.handle, inboundOpen: !!row.inbound_open, agentPublicKeyPem: row.agent_public_key_pem }
    },

    async list() {
      const rows = db.query<CardRow, []>('SELECT handle, card_json FROM registrations ORDER BY handle').all()
      return rows.map((r): HandleListing => {
        const card = parseCard(r.card_json)
        if (!card) return { handle: r.handle }
        const listing: HandleListing = { handle: r.handle }
        if (card.card.name !== undefined) listing.name = card.card.name
        if (card.card.description !== undefined) listing.description = card.card.description
        return listing
      })
    },

    async getCard(handle) {
      const row = db
        .query<CardRow, [string]>('SELECT handle, card_json FROM registrations WHERE handle = ?')
        .get(handle)
      if (!row) return null
      return parseCard(row.card_json)
    },
  }
}
