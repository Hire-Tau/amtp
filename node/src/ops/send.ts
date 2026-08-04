// `amtp send` (spec §7.1/§7.2, §9): enqueue (signed by default, per-handle
// agent key) + immediate drain unless `--queue-only`.

import { randomUUID } from 'node:crypto'
import type { Database } from 'bun:sqlite'
import type { AmtpEngine } from 'amtp-engine'
import type { AmtpAttachmentRef } from 'amtp-protocol'
import { canonicalAgentSigBytes, formatAmtpAddress, signEnvelope } from 'amtp-protocol'
import { getRegistration } from './registrations'

export interface SendArgs {
  toAddress: string
  content: string
  /** Defaults when exactly one registration exists (spec §7.2). */
  fromHandle?: string
  subject?: string
  /** Ids of attachments staged via `amtp attach upload`. */
  attachIds?: string[]
  /** REMOTE envelope id this message replies to (as shown by `inbox read`). */
  inReplyTo?: string
  /** Explicit envelope id — also the idempotency key (a re-run with the same id is a no-op). */
  envelopeId?: string
  /** Default true: sends are signed unless explicitly opted out (`--no-sign`). */
  sign?: boolean
  /** Skip the immediate drain; leave the entry queued. */
  queueOnly?: boolean
}

export type SendStatus = 'delivered' | 'pending' | 'delivering' | 'failed'

export interface SendResult {
  outboxId: string
  envelopeId: string
  status: SendStatus
  nextAttemptAt?: number
  lastError?: string
}

interface AttachmentRow {
  id: string
  filename: string
  content_type: string
  byte_size: number
  sha256: string
}

function resolveFromHandle(db: Database, fromHandle: string | undefined): string {
  if (fromHandle) return fromHandle
  const rows = db.query<{ handle: string }, []>('SELECT handle FROM registrations ORDER BY handle').all()
  if (rows.length === 1) return rows[0].handle
  if (rows.length === 0) throw new Error('no handles registered — run "amtp register <handle>" first')
  throw new Error(`--from is required: multiple handles registered (${rows.map((r) => r.handle).join(', ')})`)
}

function resolveAttachments(db: Database, attachIds: string[] | undefined): AmtpAttachmentRef[] | undefined {
  if (!attachIds || attachIds.length === 0) return undefined
  return attachIds.map((id) => {
    const row = db
      .query<
        AttachmentRow,
        [string]
      >(`SELECT id, filename, content_type, byte_size, sha256 FROM attachments WHERE id = ? AND direction = 'out'`)
      .get(id)
    if (!row) throw new Error(`unknown outbound attachment: ${id} (upload it first with "amtp attach upload")`)
    return {
      id: row.id,
      filename: row.filename,
      contentType: row.content_type,
      byteSize: row.byte_size,
      sha256: row.sha256,
    }
  })
}

export async function send(db: Database, engine: AmtpEngine, args: SendArgs): Promise<SendResult> {
  const fromHandle = resolveFromHandle(db, args.fromHandle)
  const registration = getRegistration(db, fromHandle)
  if (!registration) throw new Error(`--from handle not registered: ${fromHandle}`)

  const identity = await engine.getIdentity()
  const id = args.envelopeId ?? randomUUID()
  const attachments = resolveAttachments(db, args.attachIds)
  const subject = args.subject?.trim() ? args.subject : undefined

  let agentKey: string | undefined
  let agentSig: string | undefined
  if (args.sign !== false) {
    const from = formatAmtpAddress(identity.instanceId, fromHandle)
    const subsetAttachments = (attachments ?? []).map((a) => ({
      filename: a.filename,
      contentType: a.contentType,
      byteSize: a.byteSize,
      sha256: a.sha256,
    }))
    const bytes = canonicalAgentSigBytes({
      v: 1,
      id,
      from,
      to: args.toAddress,
      subject,
      content: args.content,
      attachments: subsetAttachments,
    })
    agentSig = signEnvelope(registration.agentPrivateKeyPem, bytes)
    agentKey = registration.agentPublicKeyPem
  }

  const result = await engine.enqueueSend({
    fromHandle,
    toAddress: args.toAddress,
    subject,
    content: args.content,
    inReplyTo: args.inReplyTo,
    attachments,
    id,
    agentKey,
    agentSig,
  })
  if (!result.ok) throw new Error(`invalid amtp:// address: ${args.toAddress}`)

  if (!args.queueOnly) {
    await engine.drainOutboxOnce()
  }

  const row = db
    .query<
      { status: SendStatus; next_attempt_at: number; last_error: string | null },
      [string]
    >('SELECT status, next_attempt_at, last_error FROM outbox WHERE id = ?')
    .get(result.entry.id)!

  return {
    outboxId: result.entry.id,
    envelopeId: id,
    status: row.status,
    ...(row.status === 'pending' ? { nextAttemptAt: row.next_attempt_at } : {}),
    ...(row.status === 'failed' && row.last_error ? { lastError: row.last_error } : {}),
  }
}
