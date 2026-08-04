// `amtp inbox list/read` (spec §7.2, §8.2): cursor keyed `(received_at, id)`
// — the id tiebreak makes pagination stable when messages share a
// millisecond timestamp.

import type { Database } from 'bun:sqlite'

export interface MessageSummary {
  id: string
  kind: 'received' | 'bounce'
  handle: string
  from: string
  subject: string | null
  receivedAt: number
  read: boolean
  attachmentCount: number
  envelopeId: string | null
}

export interface ListInboxArgs {
  handle?: string
  unreadOnly?: boolean
  limit?: number
  /** Cursor: strictly older than `(receivedAt, id)`, per the `(received_at, id)` ordering key. */
  before?: { receivedAt: number; id: string }
}

const DEFAULT_LIMIT = 20

interface MessageSummaryRow {
  id: string
  kind: 'received' | 'bounce'
  handle: string
  from_address: string
  subject: string | null
  received_at: number
  read_at: number | null
  envelope_id: string | null
  attachment_count: number
}

export function listInbox(db: Database, args: ListInboxArgs = {}): MessageSummary[] {
  const clauses: string[] = []
  const params: (string | number)[] = []

  if (args.handle) {
    clauses.push('m.handle = ?')
    params.push(args.handle)
  }
  if (args.unreadOnly) {
    clauses.push('m.read_at IS NULL')
  }
  if (args.before) {
    clauses.push('(m.received_at < ? OR (m.received_at = ? AND m.id < ?))')
    params.push(args.before.receivedAt, args.before.receivedAt, args.before.id)
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
  const limit = args.limit ?? DEFAULT_LIMIT

  const rows = db
    .query<MessageSummaryRow, (string | number)[]>(
      `SELECT m.id, m.kind, m.handle, m.from_address, m.subject, m.received_at, m.read_at, m.envelope_id,
              (SELECT COUNT(*) FROM attachments a WHERE a.message_id = m.id) AS attachment_count
       FROM messages m
       ${where}
       ORDER BY m.received_at DESC, m.id DESC
       LIMIT ?`
    )
    .all(...params, limit)

  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    handle: r.handle,
    from: r.from_address,
    subject: r.subject,
    receivedAt: r.received_at,
    read: r.read_at !== null,
    attachmentCount: r.attachment_count,
    envelopeId: r.envelope_id,
  }))
}

export interface AttachmentSummary {
  id: string
  filename: string
  contentType: string
  byteSize: number
  sha256: string
}

export interface BounceMetadata {
  outboxId: string
  envelopeId: string
  toAddress: string
  reason: string
}

export interface FullMessage {
  id: string
  kind: 'received' | 'bounce'
  handle: string
  from: string
  subject: string | null
  content: string
  receivedAt: number
  read: boolean
  envelopeId: string | null
  inReplyTo: string | null
  agentKey: string | null
  agentSigVerified: boolean
  attachments: AttachmentSummary[]
  bounce?: BounceMetadata
}

interface MessageRow {
  id: string
  kind: 'received' | 'bounce'
  handle: string
  from_address: string
  subject: string | null
  content: string
  in_reply_to: string | null
  envelope_id: string | null
  agent_key: string | null
  agent_sig_verified: number
  bounce_json: string | null
  received_at: number
  read_at: number | null
}

export interface ReadMessageArgs {
  keepUnread?: boolean
}

/** `amtp inbox read <messageId>`: full message incl. envelopeId + the AMTP.md §4.5 MUST-surface `agentSigVerified` flag; marks read unless `keepUnread`. */
export function readMessage(db: Database, messageId: string, args: ReadMessageArgs = {}): FullMessage {
  const row = db.query<MessageRow, [string]>('SELECT * FROM messages WHERE id = ?').get(messageId)
  if (!row) throw new Error(`unknown message: ${messageId}`)

  let readAt = row.read_at
  if (!args.keepUnread && readAt === null) {
    readAt = Date.now()
    db.run('UPDATE messages SET read_at = ? WHERE id = ?', [readAt, messageId])
  }

  const attachments = db
    .query<{ id: string; filename: string; content_type: string; byte_size: number; sha256: string }, [string]>(
      'SELECT id, filename, content_type, byte_size, sha256 FROM attachments WHERE message_id = ?'
    )
    .all(messageId)
    .map((a) => ({
      id: a.id,
      filename: a.filename,
      contentType: a.content_type,
      byteSize: a.byte_size,
      sha256: a.sha256,
    }))

  return {
    id: row.id,
    kind: row.kind,
    handle: row.handle,
    from: row.from_address,
    subject: row.subject,
    content: row.content,
    receivedAt: row.received_at,
    read: readAt !== null,
    envelopeId: row.envelope_id,
    inReplyTo: row.in_reply_to,
    agentKey: row.agent_key,
    agentSigVerified: !!row.agent_sig_verified,
    attachments,
    bounce: row.kind === 'bounce' && row.bounce_json ? (JSON.parse(row.bounce_json) as BounceMetadata) : undefined,
  }
}
