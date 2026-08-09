// The 13 `amtp mcp` tools (spec §8.2): 1:1 wrappers over the `ops/*` layer
// (§7.1) — the SAME code the CLI verbs call, never duplicated. `inputSchema`
// is the raw JSON Schema transcribed verbatim from §8.2's table (every
// object `additionalProperties: false` per the section preamble). Peer
// add/remove and `init` are deliberately NOT tools (§8.2: peering is a
// human-operator trust decision, AMTP.md §4.2).
//
// `amtp_list_inbox`'s `before` cursor is a plain message id in the tool
// schema (§8.2), but `ops/inbox.ts`'s `listInbox` needs the compound
// `(receivedAt, id)` key it orders by — this module resolves the id to its
// `receivedAt` with a tiny direct lookup (not a duplicate of the ops
// pagination/filtering logic, which stays entirely in `listInbox`).

import type { Database } from 'bun:sqlite'
import type { AmtpEngine } from 'amtp-engine'
import { downloadAttachment, uploadAttachment } from '../ops/attach'
import { getCard, setCard } from '../ops/cards'
import { fetchPeerHandles } from '../ops/handles'
import { getIdentity, getWhoami } from '../ops/identity'
import { listInbox, readMessage } from '../ops/inbox'
import { listPeers } from '../ops/peers'
import { addAllowRule, listAllowRules, removeAllowRule } from '../ops/allow'
import { register, setInboundOpen } from '../ops/registrations'
import { send } from '../ops/send'

export interface McpToolContext {
  db: Database
  home: string
  engine: AmtpEngine
}

export interface McpTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  handler: (ctx: McpToolContext, args: Record<string, unknown>) => unknown | Promise<unknown>
}

type Args = Record<string, unknown>

function str(args: Args, key: string): string | undefined {
  const v = args[key]
  return typeof v === 'string' ? v : undefined
}

function requireStr(args: Args, key: string): string {
  const v = str(args, key)
  if (v === undefined) throw new Error(`missing required argument: ${key}`)
  return v
}

function bool(args: Args, key: string): boolean | undefined {
  const v = args[key]
  return typeof v === 'boolean' ? v : undefined
}

function requireBool(args: Args, key: string): boolean {
  const v = bool(args, key)
  if (v === undefined) throw new Error(`missing required argument: ${key}`)
  return v
}

function num(args: Args, key: string): number | undefined {
  const v = args[key]
  return typeof v === 'number' ? v : undefined
}

function strArray(args: Args, key: string): string[] | undefined {
  const v = args[key]
  if (!Array.isArray(v)) return undefined
  return v.filter((x): x is string => typeof x === 'string')
}

/**
 * `ops/cards.ts`'s `getCard` throws a raw `SyntaxError` straight out of
 * `JSON.parse` on a corrupt `card_json` row (unlike the handle-directory
 * adapter, which degrades a bad row to `null`). This tool layer must not let
 * that raw parse error escape as-is into the MCP tool-error channel — rewrap
 * it into a clear, actionable message.
 */
function safeGetCard(db: Database, handle: string): ReturnType<typeof getCard> {
  try {
    return getCard(db, handle)
  } catch (error) {
    throw new Error(
      `stored card for handle "${handle}" is corrupted and could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }
}

function resolveInboxCursor(
  db: Database,
  beforeId: string | undefined
): { receivedAt: number; id: string } | undefined {
  if (beforeId === undefined) return undefined
  const row = db.query<{ received_at: number }, [string]>('SELECT received_at FROM messages WHERE id = ?').get(beforeId)
  if (!row) throw new Error(`unknown message: ${beforeId}`)
  return { receivedAt: row.received_at, id: beforeId }
}

export const MCP_TOOLS: McpTool[] = [
  {
    name: 'amtp_whoami',
    description:
      "Learn this node's own AMTP identity: its instance id and every registered handle's full amtp:// address — how an agent discovers its own mailing address.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: (ctx) => {
      const whoami = getWhoami(ctx.db)
      return {
        instanceId: whoami.instanceId,
        handles: whoami.registrations.map((r) => ({
          handle: r.handle,
          address: r.address,
          inboundOpen: r.inboundOpen,
          ...(r.name !== undefined ? { name: r.name } : {}),
        })),
      }
    },
  },
  {
    name: 'amtp_send_message',
    description:
      "Send mail to a remote agent at an amtp://instanceId/handle address. Requires the recipient's operator to have peered with this node. Attachments must be staged first with amtp_upload_attachment.",
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient amtp:// address' },
        content: { type: 'string', description: 'Message body' },
        from_handle: {
          type: 'string',
          description: 'Authoring local handle (defaults when exactly one handle is registered)',
        },
        subject: { type: 'string' },
        in_reply_to_envelope_id: { type: 'string', description: 'Remote envelope id this message replies to' },
        attachment_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Ids returned by amtp_upload_attachment',
        },
        sign: { type: 'boolean', default: true },
        queue_only: { type: 'boolean', default: false },
      },
      required: ['to', 'content'],
      additionalProperties: false,
    },
    handler: async (ctx, args) => {
      const result = await send(ctx.db, ctx.engine, {
        toAddress: requireStr(args, 'to'),
        content: requireStr(args, 'content'),
        fromHandle: str(args, 'from_handle'),
        subject: str(args, 'subject'),
        inReplyTo: str(args, 'in_reply_to_envelope_id'),
        attachIds: strArray(args, 'attachment_ids'),
        sign: bool(args, 'sign'),
        queueOnly: bool(args, 'queue_only'),
      })
      return {
        outboxId: result.outboxId,
        envelopeId: result.envelopeId,
        status: result.status,
        ...(result.lastError ? { lastError: result.lastError } : {}),
      }
    },
  },
  {
    name: 'amtp_list_inbox',
    description:
      'List inbox message summaries, newest first. This is also the poll tool: call with unread_only=true to check for new mail, and page older history with the `before` cursor (an id from a previous result).',
    inputSchema: {
      type: 'object',
      properties: {
        handle: { type: 'string' },
        unread_only: { type: 'boolean', default: false },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
        before: { type: 'string', description: 'Message id cursor: return only messages strictly older than this one' },
      },
      additionalProperties: false,
    },
    handler: (ctx, args) => {
      const before = resolveInboxCursor(ctx.db, str(args, 'before'))
      return listInbox(ctx.db, {
        handle: str(args, 'handle'),
        unreadOnly: bool(args, 'unread_only'),
        limit: num(args, 'limit'),
        before,
      })
    },
  },
  {
    name: 'amtp_read_message',
    description:
      'Read a full inbox message or bounce by id (see amtp_list_inbox), including its content and attachments; marks it read unless mark_read is false.',
    inputSchema: {
      type: 'object',
      properties: {
        message_id: { type: 'string' },
        mark_read: { type: 'boolean', default: true },
      },
      required: ['message_id'],
      additionalProperties: false,
    },
    handler: (ctx, args) => {
      const markRead = bool(args, 'mark_read')
      return readMessage(ctx.db, requireStr(args, 'message_id'), { keepUnread: markRead === false })
    },
  },
  {
    name: 'amtp_download_attachment',
    description:
      "Copy a received attachment's local blob to save_path, or report its stored blob path when save_path is omitted.",
    inputSchema: {
      type: 'object',
      properties: {
        attachment_id: { type: 'string' },
        save_path: { type: 'string' },
      },
      required: ['attachment_id'],
      additionalProperties: false,
    },
    handler: (ctx, args) =>
      downloadAttachment(ctx.db, ctx.home, requireStr(args, 'attachment_id'), str(args, 'save_path')),
  },
  {
    name: 'amtp_upload_attachment',
    description: 'Stage a local file as an outbound attachment; pass the returned attachmentId to amtp_send_message.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        filename: { type: 'string' },
        content_type: { type: 'string' },
      },
      required: ['file_path'],
      additionalProperties: false,
    },
    handler: (ctx, args) => {
      const result = uploadAttachment(ctx.db, ctx.home, requireStr(args, 'file_path'), {
        filename: str(args, 'filename'),
        contentType: str(args, 'content_type'),
      })
      return { attachmentId: result.attachmentId, byteSize: result.byteSize, sha256: result.sha256 }
    },
  },
  {
    name: 'amtp_register_handle',
    description:
      'Claim a local handle (amtp://<instanceId>/<handle>); re-running on an existing handle is an idempotent no-op.',
    inputSchema: {
      type: 'object',
      properties: {
        handle: { type: 'string' },
        open: { type: 'boolean', default: false },
        name: { type: 'string', description: 'Also publish a card with this display name' },
        description: { type: 'string', description: 'Also publish a card with this description' },
      },
      required: ['handle'],
      additionalProperties: false,
    },
    handler: (ctx, args) => {
      const identity = getIdentity(ctx.db)
      const handle = requireStr(args, 'handle')
      const result = register(ctx.db, identity.instanceId, {
        handle,
        open: bool(args, 'open'),
      })
      const name = str(args, 'name')
      const description = str(args, 'description')
      const out: Record<string, unknown> = {
        handle: result.handle,
        address: result.address,
        agentPublicKeyPem: result.agentPublicKeyPem,
      }
      if (name !== undefined || description !== undefined) {
        out.card = setCard(ctx.db, identity.instanceId, { handle, name, description })
      }
      return out
    },
  },
  {
    name: 'amtp_set_mailbox',
    description: "Open or close a registered handle's mailbox for inbound mail.",
    inputSchema: {
      type: 'object',
      properties: {
        handle: { type: 'string' },
        open: { type: 'boolean' },
      },
      required: ['handle', 'open'],
      additionalProperties: false,
    },
    handler: (ctx, args) => {
      const handle = requireStr(args, 'handle')
      const open = requireBool(args, 'open')
      setInboundOpen(ctx.db, handle, open)
      return { handle, open }
    },
  },
  {
    name: 'amtp_set_card',
    description: "Sign and publish a registered handle's agent card (spec §4.6), replacing any existing card.",
    inputSchema: {
      type: 'object',
      properties: {
        handle: { type: 'string' },
        name: { type: 'string', description: 'Display name (≤ 200 chars)' },
        description: { type: 'string', description: 'Bio / who this agent is (≤ 2000 chars)' },
        extensions: { type: 'object', description: 'Arbitrary JSON-safe extension entries' },
      },
      required: ['handle'],
      additionalProperties: false,
    },
    handler: (ctx, args) => {
      const identity = getIdentity(ctx.db)
      const extensions = args.extensions
      return setCard(ctx.db, identity.instanceId, {
        handle: requireStr(args, 'handle'),
        name: str(args, 'name'),
        description: str(args, 'description'),
        extensions:
          extensions !== null && typeof extensions === 'object' && !Array.isArray(extensions)
            ? (extensions as Record<string, unknown>)
            : undefined,
      })
    },
  },
  {
    name: 'amtp_get_card',
    description: "Read a registered handle's locally stored signed agent card, or null if none is published.",
    inputSchema: {
      type: 'object',
      properties: { handle: { type: 'string' } },
      required: ['handle'],
      additionalProperties: false,
    },
    handler: (ctx, args) => ({ card: safeGetCard(ctx.db, requireStr(args, 'handle')) }),
  },
  {
    name: 'amtp_fetch_peer_card',
    description: "Fetch and VERIFY a peer handle's signed agent card (TOFU-pinned signature, spec §4.6).",
    inputSchema: {
      type: 'object',
      properties: {
        peerInstanceId: { type: 'string' },
        handle: { type: 'string' },
      },
      required: ['peerInstanceId', 'handle'],
      additionalProperties: false,
    },
    handler: (ctx, args) =>
      ctx.engine.fetchPeerAgentCard({
        peerInstanceId: requireStr(args, 'peerInstanceId'),
        handle: requireStr(args, 'handle'),
      }),
  },
  {
    name: 'amtp_list_peers',
    description: 'List peered nodes — the valid amtp:// send targets.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: (ctx) =>
      listPeers(ctx.db).map((p) => ({
        alias: p.alias,
        instanceId: p.instanceId,
        baseUrl: p.baseUrl,
        ...(p.legacySignedGetPathPrefix !== undefined ? { legacySignedGetPathPrefix: p.legacySignedGetPathPrefix } : {}),
        status: p.status,
      })),
  },
  {
    name: 'amtp_list_peer_handles',
    description: "Fetch a peer's published handles (a signed GET to the peer) as full amtp:// addresses.",
    inputSchema: {
      type: 'object',
      properties: { peer: { type: 'string', description: 'Peer alias or instance id' } },
      required: ['peer'],
      additionalProperties: false,
    },
    handler: (ctx, args) => fetchPeerHandles(ctx.engine, ctx.db, requireStr(args, 'peer')),
  },
  {
    name: 'amtp_add_allow_rule',
    description:
      'Add a receive-policy allow rule for a closed mailbox: allow mail from a peer (any sender), or restrict it to one remote sender handle.',
    inputSchema: {
      type: 'object',
      properties: {
        handle: { type: 'string' },
        peer: { type: 'string' },
        sender_handle: { type: 'string' },
      },
      required: ['handle', 'peer'],
      additionalProperties: false,
    },
    handler: (ctx, args) =>
      addAllowRule(ctx.db, {
        handle: requireStr(args, 'handle'),
        peerRef: requireStr(args, 'peer'),
        senderHandle: str(args, 'sender_handle'),
      }),
  },
  {
    name: 'amtp_list_allow_rules',
    description: 'List receive-policy allow rules, optionally filtered to one local handle.',
    inputSchema: {
      type: 'object',
      properties: { handle: { type: 'string' } },
      additionalProperties: false,
    },
    handler: (ctx, args) => listAllowRules(ctx.db, str(args, 'handle')),
  },
  {
    name: 'amtp_remove_allow_rule',
    description: 'Remove an allow rule by id (see amtp_list_allow_rules).',
    inputSchema: {
      type: 'object',
      properties: { rule_id: { type: 'string' } },
      required: ['rule_id'],
      additionalProperties: false,
    },
    handler: (ctx, args) => ({ removed: removeAllowRule(ctx.db, requireStr(args, 'rule_id')) }),
  },
]
