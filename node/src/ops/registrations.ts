// `amtp register`/`amtp open`/`amtp close` (spec §7.2, §9). Per-handle agent
// keypairs (§9): generated at register, regenerated only under
// `--regenerate`.

import type { Database } from 'bun:sqlite'
import { formatAmtpAddress, generateInstanceKeyPair } from 'amtp-protocol'

// AMTP.md §3 handle grammar.
const HANDLE_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/
const HANDLE_MAX_LEN = 200

export function validateHandle(handle: string): void {
  if (handle.length === 0 || handle.length > HANDLE_MAX_LEN || !HANDLE_RE.test(handle)) {
    throw new Error(
      `invalid handle "${handle}": must match ^[a-zA-Z0-9][a-zA-Z0-9_-]*$ and be at most ${HANDLE_MAX_LEN} characters`
    )
  }
}

export interface RegistrationRow {
  handle: string
  inboundOpen: boolean
  agentPublicKeyPem: string
  agentPrivateKeyPem: string
}

interface RawRegistrationRow {
  handle: string
  inbound_open: number
  agent_public_key_pem: string
  agent_private_key_pem: string
}

export function getRegistration(db: Database, handle: string): RegistrationRow | null {
  const row = db
    .query<
      RawRegistrationRow,
      [string]
    >('SELECT handle, inbound_open, agent_public_key_pem, agent_private_key_pem FROM registrations WHERE handle = ?')
    .get(handle)
  if (!row) return null
  return {
    handle: row.handle,
    inboundOpen: !!row.inbound_open,
    agentPublicKeyPem: row.agent_public_key_pem,
    agentPrivateKeyPem: row.agent_private_key_pem,
  }
}

export interface RegisterArgs {
  handle: string
  open?: boolean
  regenerate?: boolean
}

export interface RegisterResult {
  handle: string
  address: string
  agentPublicKeyPem: string
  inboundOpen: boolean
  /** True when the handle already existed before this call (with or without `--regenerate`). */
  alreadyRegistered: boolean
  /** True iff the agent keypair was just regenerated (`--regenerate` on an existing handle). */
  regenerated: boolean
}

/**
 * `amtp register` (spec §7.2/§9): re-running on an existing handle is an
 * idempotent no-op (the existing address/key are returned unchanged) except
 * that `--open`/`--close` toggles still apply; the keypair is regenerated
 * ONLY under `--regenerate`.
 */
export function register(db: Database, instanceId: string, args: RegisterArgs): RegisterResult {
  validateHandle(args.handle)
  const existing = getRegistration(db, args.handle)
  const now = Date.now()

  if (existing && !args.regenerate) {
    if (args.open !== undefined) {
      db.run('UPDATE registrations SET inbound_open = ? WHERE handle = ?', [args.open ? 1 : 0, args.handle])
    }
    const row = getRegistration(db, args.handle)!
    return {
      handle: row.handle,
      address: formatAmtpAddress(instanceId, row.handle),
      agentPublicKeyPem: row.agentPublicKeyPem,
      inboundOpen: row.inboundOpen,
      alreadyRegistered: true,
      regenerated: false,
    }
  }

  const finalInboundOpen = args.open !== undefined ? args.open : !!existing?.inboundOpen
  const { publicKeyPem, privateKeyPem } = generateInstanceKeyPair()

  if (existing) {
    // `--regenerate` rotates the agent keypair, so any previously published
    // card's signature can no longer verify (§4.6/§9) — clear it rather than
    // serve a card whose cardSig is now bogus.
    db.run(
      'UPDATE registrations SET agent_public_key_pem = ?, agent_private_key_pem = ?, inbound_open = ?, card_json = NULL WHERE handle = ?',
      [publicKeyPem, privateKeyPem, finalInboundOpen ? 1 : 0, args.handle]
    )
  } else {
    db.run(
      'INSERT INTO registrations (handle, inbound_open, agent_public_key_pem, agent_private_key_pem, created_at) VALUES (?, ?, ?, ?, ?)',
      [args.handle, finalInboundOpen ? 1 : 0, publicKeyPem, privateKeyPem, now]
    )
  }

  return {
    handle: args.handle,
    address: formatAmtpAddress(instanceId, args.handle),
    agentPublicKeyPem: publicKeyPem,
    inboundOpen: finalInboundOpen,
    alreadyRegistered: !!existing,
    regenerated: !!existing,
  }
}

/** `amtp open`/`amtp close <handle>` (spec §7.2). */
export function setInboundOpen(db: Database, handle: string, open: boolean): void {
  const res = db.run('UPDATE registrations SET inbound_open = ? WHERE handle = ?', [open ? 1 : 0, handle])
  if (res.changes === 0) throw new Error(`handle not registered: ${handle}`)
}
