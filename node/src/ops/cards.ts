// `amtp card set`/`amtp card clear` (spec §4.6, §7.2): build, sign (with the
// handle's agent key), validate, and store a handle's published agent card.

import type { Database } from 'bun:sqlite'
import {
  amtpAgentCardSchema,
  signAgentCard,
  signedCardByteSize,
  SIGNED_CARD_MAX_BYTES,
  type AmtpAgentCard,
  type AmtpSignedAgentCard,
} from 'amtp-protocol'
import { getRegistration } from './registrations'

export interface SetCardArgs {
  handle: string
  name?: string
  description?: string
  extensions?: Record<string, unknown>
}

/** Build, sign (with the handle's agent key), validate, and store the card. */
export function setCard(db: Database, instanceId: string, args: SetCardArgs): AmtpSignedAgentCard {
  const reg = getRegistration(db, args.handle)
  if (!reg) throw new Error(`handle not registered: ${args.handle}`)

  const card: AmtpAgentCard = {}
  if (args.name !== undefined) card.name = args.name
  if (args.description !== undefined) card.description = args.description
  if (args.extensions !== undefined && Object.keys(args.extensions).length > 0)
    card.extensions = args.extensions as AmtpAgentCard['extensions']

  const parsed = amtpAgentCardSchema.parse(card) // enforces field caps + JSON-safe extensions
  const sansSig = { v: 1 as const, instanceId, handle: args.handle, card: parsed }
  const signed: AmtpSignedAgentCard = { ...sansSig, cardSig: signAgentCard(reg.agentPrivateKeyPem, sansSig) }
  if (signedCardByteSize(signed) > SIGNED_CARD_MAX_BYTES) throw new Error(`card exceeds ${SIGNED_CARD_MAX_BYTES} bytes`)

  db.run('UPDATE registrations SET card_json = ? WHERE handle = ?', [JSON.stringify(signed), args.handle])
  return signed
}

export function getCard(db: Database, handle: string): AmtpSignedAgentCard | null {
  const row = db
    .query<{ card_json: string | null }, [string]>('SELECT card_json FROM registrations WHERE handle = ?')
    .get(handle)
  if (!row?.card_json) return null
  return JSON.parse(row.card_json) as AmtpSignedAgentCard
}

export function clearCard(db: Database, handle: string): void {
  db.run('UPDATE registrations SET card_json = NULL WHERE handle = ?', [handle])
}
