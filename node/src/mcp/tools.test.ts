// Spec: docs/superpowers/specs/2026-07-08-amtp-node-design.md §8.2 (13
// tools, exact JSON schemas) and §8.4 (poll model, no push).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'bun:sqlite'
import { createAmtpEngine } from 'amtp-engine'
import type { AmtpEngine } from 'amtp-engine'
import { formatAmtpAddress, generateInstanceKeyPair, instanceIdFromPublicKeyPem, signAgentCard } from 'amtp-protocol'
import { buildAdapters } from '../adapters'
import { openDb } from '../db/open'
import { dbPath, ensureAmtpDirs } from '../home'
import { runInit } from '../ops/init'
import { addPeer } from '../ops/peers'
import { register } from '../ops/registrations'
import { MCP_TOOLS } from './tools'
import type { McpToolContext } from './tools'

// The §8.2 table, transcribed independently of ./tools.ts's own literals —
// this is the snapshot the tool definitions must match exactly.
const EXPECTED_SCHEMAS: Record<string, Record<string, unknown>> = {
  amtp_whoami: { type: 'object', properties: {}, additionalProperties: false },
  amtp_send_message: {
    type: 'object',
    properties: {
      to: { type: 'string' },
      content: { type: 'string' },
      from_handle: { type: 'string' },
      subject: { type: 'string' },
      in_reply_to_envelope_id: { type: 'string' },
      attachment_ids: { type: 'array', items: { type: 'string' } },
      sign: { type: 'boolean', default: true },
      queue_only: { type: 'boolean', default: false },
    },
    required: ['to', 'content'],
    additionalProperties: false,
  },
  amtp_list_inbox: {
    type: 'object',
    properties: {
      handle: { type: 'string' },
      unread_only: { type: 'boolean', default: false },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      before: { type: 'string' },
    },
    additionalProperties: false,
  },
  amtp_read_message: {
    type: 'object',
    properties: {
      message_id: { type: 'string' },
      mark_read: { type: 'boolean', default: true },
    },
    required: ['message_id'],
    additionalProperties: false,
  },
  amtp_download_attachment: {
    type: 'object',
    properties: {
      attachment_id: { type: 'string' },
      save_path: { type: 'string' },
    },
    required: ['attachment_id'],
    additionalProperties: false,
  },
  amtp_upload_attachment: {
    type: 'object',
    properties: {
      file_path: { type: 'string' },
      filename: { type: 'string' },
      content_type: { type: 'string' },
    },
    required: ['file_path'],
    additionalProperties: false,
  },
  amtp_register_handle: {
    type: 'object',
    properties: {
      handle: { type: 'string' },
      open: { type: 'boolean', default: false },
      name: { type: 'string' },
      description: { type: 'string' },
    },
    required: ['handle'],
    additionalProperties: false,
  },
  amtp_set_mailbox: {
    type: 'object',
    properties: {
      handle: { type: 'string' },
      open: { type: 'boolean' },
    },
    required: ['handle', 'open'],
    additionalProperties: false,
  },
  amtp_set_card: {
    type: 'object',
    properties: {
      handle: { type: 'string' },
      name: { type: 'string' },
      description: { type: 'string' },
      extensions: { type: 'object' },
    },
    required: ['handle'],
    additionalProperties: false,
  },
  amtp_get_card: {
    type: 'object',
    properties: { handle: { type: 'string' } },
    required: ['handle'],
    additionalProperties: false,
  },
  amtp_fetch_peer_card: {
    type: 'object',
    properties: {
      peerInstanceId: { type: 'string' },
      handle: { type: 'string' },
    },
    required: ['peerInstanceId', 'handle'],
    additionalProperties: false,
  },
  amtp_list_peers: { type: 'object', properties: {}, additionalProperties: false },
  amtp_list_peer_handles: {
    type: 'object',
    properties: { peer: { type: 'string' } },
    required: ['peer'],
    additionalProperties: false,
  },
  amtp_add_allow_rule: {
    type: 'object',
    properties: {
      handle: { type: 'string' },
      peer: { type: 'string' },
      sender_handle: { type: 'string' },
    },
    required: ['handle', 'peer'],
    additionalProperties: false,
  },
  amtp_list_allow_rules: {
    type: 'object',
    properties: { handle: { type: 'string' } },
    additionalProperties: false,
  },
  amtp_remove_allow_rule: {
    type: 'object',
    properties: { rule_id: { type: 'string' } },
    required: ['rule_id'],
    additionalProperties: false,
  },
}

// A JSON Schema property may carry a `description` on top of the fields
// snapshotted above — strip those before comparing so this test asserts on
// structure/constraints/defaults, not on prose wording (§8.3: "exact strings
// are an implementation-plan concern").
function stripDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripDescriptions)
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    // A `description` key is only prose annotation (to strip) on an actual
    // schema-descriptor node (one that also carries `type`) — e.g. `{ type:
    // 'string', description: '...' }`. `amtp_set_card`/`amtp_register_handle`
    // now have a *property literally named* `description` (the card bio
    // field) sitting inside a `properties` map, which has no `type` key of
    // its own — that key must survive, only its own descriptor's prose gets
    // stripped one level down.
    const isSchemaDescriptorNode = typeof obj.type === 'string'
    for (const [k, v] of Object.entries(obj)) {
      if (k === 'description' && isSchemaDescriptorNode) continue
      out[k] = stripDescriptions(v)
    }
    return out
  }
  return value
}

describe('MCP_TOOLS schema snapshot (spec §8.2 + card tools)', () => {
  test('exposes exactly the tools named in the snapshot (13 spec tools + 3 card tools)', () => {
    expect(MCP_TOOLS.map((t) => t.name).sort()).toEqual(Object.keys(EXPECTED_SCHEMAS).sort())
  })

  test('every tool has a non-empty description', () => {
    for (const tool of MCP_TOOLS) {
      expect(tool.description.length).toBeGreaterThan(0)
    }
  })

  for (const tool of MCP_TOOLS) {
    test(`${tool.name} inputSchema matches §8.2 exactly (description text aside)`, () => {
      expect(stripDescriptions(tool.inputSchema)).toEqual(EXPECTED_SCHEMAS[tool.name])
    })
  }
})

function findTool(name: string) {
  const tool = MCP_TOOLS.find((t) => t.name === name)
  if (!tool) throw new Error(`test setup error: no such tool ${name}`)
  return tool
}

let workDir: string
let home: string
let db: Database
let instanceId: string
let peerInstanceId: string

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'amtp-mcp-tools-test-'))
  home = join(workDir, 'home')
  ensureAmtpDirs(home)
  const init = runInit(home)
  instanceId = init.instanceId
  db = openDb(dbPath(home))
  register(db, instanceId, { handle: 'alice' })

  const peerKeys = generateInstanceKeyPair()
  peerInstanceId = instanceIdFromPublicKeyPem(peerKeys.publicKeyPem)
  addPeer(db, { alias: 'bob-peer', baseUrl: 'http://peer.example', publicKeyPem: peerKeys.publicKeyPem })
})

afterEach(() => {
  db.close()
  rmSync(workDir, { recursive: true, force: true })
})

type FetchStub = (url: string | URL | Request, init?: RequestInit) => Promise<Response>

function buildCtx(fetchImpl?: FetchStub): McpToolContext {
  const engine: AmtpEngine = createAmtpEngine(
    buildAdapters(db, home),
    fetchImpl ? { fetch: fetchImpl as unknown as typeof globalThis.fetch } : {}
  )
  return { db, home, engine }
}

function seedMessage(opts: {
  id?: string
  handle: string
  receivedAt: number
  subject?: string
  content?: string
}): string {
  const id = opts.id ?? randomUUID()
  db.run(
    `INSERT INTO messages (id, kind, handle, from_address, envelope_id, subject, content, bounce_json, received_at, read_at)
     VALUES (?, 'received', ?, ?, ?, ?, ?, NULL, ?, NULL)`,
    [
      id,
      opts.handle,
      `amtp://${peerInstanceId}/bob`,
      randomUUID(),
      opts.subject ?? null,
      opts.content ?? 'hello',
      opts.receivedAt,
    ]
  )
  return id
}

describe('MCP tool handlers (direct, over a temp home)', () => {
  test('amtp_whoami reports the instance id and registered handles', () => {
    const result = findTool('amtp_whoami').handler(buildCtx(), {}) as {
      instanceId: string
      handles: { handle: string; address: string; inboundOpen: boolean }[]
    }
    expect(result.instanceId).toBe(instanceId)
    expect(result.handles).toEqual([
      { handle: 'alice', address: formatAmtpAddress(instanceId, 'alice'), inboundOpen: false },
    ])
  })

  test('amtp_send_message enqueues + drains, reporting delivered from the stubbed peer', async () => {
    const ctx = buildCtx(async () => new Response(JSON.stringify({ accepted: true }), { status: 200 }))
    const result = (await findTool('amtp_send_message').handler(ctx, {
      to: `amtp://${peerInstanceId}/bob`,
      content: 'hi from mcp',
      from_handle: 'alice',
    })) as { outboxId: string; envelopeId: string; status: string; lastError?: string }

    expect(result.status).toBe('delivered')
    expect(result.outboxId).toBeTruthy()
    expect(result.envelopeId).toBeTruthy()
    expect(result.lastError).toBeUndefined()
  })

  test('amtp_send_message --queue_only skips the drain (status pending)', async () => {
    let called = false
    const ctx = buildCtx(async () => {
      called = true
      return new Response(JSON.stringify({ accepted: true }), { status: 200 })
    })
    const result = (await findTool('amtp_send_message').handler(ctx, {
      to: `amtp://${peerInstanceId}/bob`,
      content: 'queued',
      from_handle: 'alice',
      queue_only: true,
    })) as { status: string }

    expect(result.status).toBe('pending')
    expect(called).toBe(false)
  })

  test('amtp_send_message requires "to" and "content"', async () => {
    const ctx = buildCtx()
    await expect(findTool('amtp_send_message').handler(ctx, { content: 'no to' })).rejects.toThrow(
      /missing required argument: to/
    )
    await expect(findTool('amtp_send_message').handler(ctx, { to: 'x' })).rejects.toThrow(
      /missing required argument: content/
    )
  })

  test('amtp_list_inbox lists newest-first and supports unread_only + before cursor', () => {
    const older = seedMessage({ handle: 'alice', receivedAt: 1000, subject: 'first' })
    const newer = seedMessage({ handle: 'alice', receivedAt: 2000, subject: 'second' })
    const ctx = buildCtx()

    const all = findTool('amtp_list_inbox').handler(ctx, {}) as { id: string }[]
    expect(all.map((m) => m.id)).toEqual([newer, older])

    const page = findTool('amtp_list_inbox').handler(ctx, { before: newer }) as { id: string }[]
    expect(page.map((m) => m.id)).toEqual([older])
  })

  test('amtp_list_inbox rejects an unknown before cursor', () => {
    const ctx = buildCtx()
    expect(() => findTool('amtp_list_inbox').handler(ctx, { before: 'ghost-id' })).toThrow(/unknown message/)
  })

  test('amtp_read_message returns the full message and marks it read by default', () => {
    const id = seedMessage({ handle: 'alice', receivedAt: 1000, content: 'body text' })
    const ctx = buildCtx()

    const message = findTool('amtp_read_message').handler(ctx, { message_id: id }) as { content: string; read: boolean }
    expect(message.content).toBe('body text')
    expect(message.read).toBe(true)

    const summary = findTool('amtp_list_inbox').handler(ctx, { unread_only: true }) as unknown[]
    expect(summary).toHaveLength(0)
  })

  // Dedicated regression for the `mark_read` double-negative (handler does
  // `keepUnread: markRead === false`): omitting the field entirely must mark
  // read, mirroring the explicit `mark_read: false` case below so the two
  // can't silently swap/regress.
  test('amtp_read_message marks read by default when mark_read is omitted', () => {
    const id = seedMessage({ handle: 'alice', receivedAt: 1000 })
    const ctx = buildCtx()
    findTool('amtp_read_message').handler(ctx, { message_id: id })
    const unread = findTool('amtp_list_inbox').handler(ctx, { unread_only: true }) as unknown[]
    expect(unread).toHaveLength(0)
  })

  test('amtp_read_message honors mark_read: false', () => {
    const id = seedMessage({ handle: 'alice', receivedAt: 1000 })
    const ctx = buildCtx()
    findTool('amtp_read_message').handler(ctx, { message_id: id, mark_read: false })
    const unread = findTool('amtp_list_inbox').handler(ctx, { unread_only: true }) as unknown[]
    expect(unread).toHaveLength(1)
  })

  test('amtp_read_message throws for an unknown message id', () => {
    const ctx = buildCtx()
    expect(() => findTool('amtp_read_message').handler(ctx, { message_id: 'ghost' })).toThrow(/unknown message/)
  })

  test('amtp_upload_attachment then amtp_download_attachment round-trips a file', () => {
    const ctx = buildCtx()
    const srcPath = join(workDir, 'note.txt')
    writeFileSync(srcPath, 'attachment bytes')

    const uploaded = findTool('amtp_upload_attachment').handler(ctx, { file_path: srcPath }) as {
      attachmentId: string
      byteSize: number
      sha256: string
    }
    expect(uploaded.attachmentId).toBeTruthy()
    expect(uploaded.byteSize).toBe('attachment bytes'.length)
    expect((uploaded as Record<string, unknown>).filename).toBeUndefined()

    const destPath = join(workDir, 'out.txt')
    // Downloading an outbound (not-yet-received) attachment still exercises
    // the same blob-copy path the ops layer implements for inbound ones.
    const downloaded = findTool('amtp_download_attachment').handler(ctx, {
      attachment_id: uploaded.attachmentId,
      save_path: destPath,
    }) as { path: string; sha256: string }
    expect(downloaded.path).toBe(destPath)
    expect(downloaded.sha256).toBe(uploaded.sha256)
  })

  test('amtp_register_handle returns the trimmed §8.2 shape and is idempotent', () => {
    const ctx = buildCtx()
    const first = findTool('amtp_register_handle').handler(ctx, { handle: 'dave' }) as Record<string, unknown>
    expect(Object.keys(first).sort()).toEqual(['address', 'agentPublicKeyPem', 'handle'])
    expect(first.handle).toBe('dave')

    const second = findTool('amtp_register_handle').handler(ctx, { handle: 'dave' }) as Record<string, unknown>
    expect(second.agentPublicKeyPem).toBe(first.agentPublicKeyPem)
  })

  test('amtp_register_handle publishes a card when name/description is given', () => {
    const ctx = buildCtx()
    const result = findTool('amtp_register_handle').handler(ctx, {
      handle: 'carol',
      name: 'Carol',
      description: 'Sales',
    }) as { card?: { card: { name?: string; description?: string } } }
    expect(result.card?.card.name).toBe('Carol')
    expect(result.card?.card.description).toBe('Sales')
  })

  test('amtp_set_card then amtp_get_card round-trips a signed card', () => {
    const ctx = buildCtx()
    const set = findTool('amtp_set_card').handler(ctx, {
      handle: 'alice',
      name: 'Alice',
      description: 'Support',
      extensions: { foo: 'bar' },
    }) as { card: { name: string; description: string; extensions: Record<string, unknown> } }
    expect(set.card).toEqual({ name: 'Alice', description: 'Support', extensions: { foo: 'bar' } })

    const got = findTool('amtp_get_card').handler(ctx, { handle: 'alice' }) as { card: unknown }
    expect(got.card).toEqual(set)
  })

  test('amtp_get_card returns { card: null } when nothing is published', () => {
    const ctx = buildCtx()
    const got = findTool('amtp_get_card').handler(ctx, { handle: 'alice' }) as { card: unknown }
    expect(got.card).toBeNull()
  })

  // Known rough edge from ops/cards.ts: `getCard` throws a raw `JSON.parse`
  // SyntaxError on a corrupt `card_json` row (unlike the handle-directory
  // adapter, which degrades to `null`). This tool layer must rewrap that into
  // a clean, non-SyntaxError Error rather than let the raw parse error escape
  // into the MCP tool-error channel.
  test('amtp_get_card wraps a corrupt card_json row into a clean error (not a raw SyntaxError)', () => {
    db.run('UPDATE registrations SET card_json = ? WHERE handle = ?', ['{not valid json', 'alice'])
    const ctx = buildCtx()
    let caught: unknown
    try {
      findTool('amtp_get_card').handler(ctx, { handle: 'alice' })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Error)
    expect(caught).not.toBeInstanceOf(SyntaxError)
    expect((caught as Error).message).toContain('corrupted')
  })

  test('amtp_whoami reports the published card name once amtp_set_card runs', () => {
    const ctx = buildCtx()
    findTool('amtp_set_card').handler(ctx, { handle: 'alice', name: 'Alice' })
    const whoami = findTool('amtp_whoami').handler(ctx, {}) as {
      handles: { handle: string; address: string; inboundOpen: boolean; name?: string }[]
    }
    expect(whoami.handles).toEqual([
      { handle: 'alice', address: formatAmtpAddress(instanceId, 'alice'), inboundOpen: false, name: 'Alice' },
    ])
  })

  test('amtp_set_mailbox opens and closes a handle', () => {
    const ctx = buildCtx()
    const opened = findTool('amtp_set_mailbox').handler(ctx, { handle: 'alice', open: true })
    expect(opened).toEqual({ handle: 'alice', open: true })

    const whoami = findTool('amtp_whoami').handler(ctx, {}) as { handles: { inboundOpen: boolean }[] }
    expect(whoami.handles[0].inboundOpen).toBe(true)
  })

  test('amtp_list_peers reports the peer without its raw public key', () => {
    const ctx = buildCtx()
    const peers = findTool('amtp_list_peers').handler(ctx, {}) as Record<string, unknown>[]
    expect(peers).toEqual([
      { alias: 'bob-peer', instanceId: peerInstanceId, baseUrl: 'http://peer.example', status: 'active' },
    ])
  })

  test('amtp_list_peers includes a configured legacy prefix and omits SQL NULL', () => {
    db.run("UPDATE peers SET legacy_signed_get_path_prefix = '/api' WHERE instance_id = ?", [peerInstanceId])
    const peers = findTool('amtp_list_peers').handler(buildCtx(), {}) as Record<string, unknown>[]
    expect(peers[0].legacySignedGetPathPrefix).toBe('/api')
  })

  test("amtp_list_peer_handles fetches and formats a peer's handles", async () => {
    const ctx = buildCtx(async () => new Response(JSON.stringify({ handles: [{ handle: 'bob' }] }), { status: 200 }))
    const handles = await findTool('amtp_list_peer_handles').handler(ctx, { peer: 'bob-peer' })
    expect(handles).toEqual([{ handle: 'bob', address: formatAmtpAddress(peerInstanceId, 'bob') }])
  })

  test('amtp_list_peer_handles passes the name/description hints through intact', async () => {
    const ctx = buildCtx(
      async () =>
        new Response(JSON.stringify({ handles: [{ handle: 'bob', name: 'Bob', description: 'Support' }] }), {
          status: 200,
        })
    )
    const handles = await findTool('amtp_list_peer_handles').handler(ctx, { peer: 'bob-peer' })
    expect(handles).toEqual([
      { handle: 'bob', address: formatAmtpAddress(peerInstanceId, 'bob'), name: 'Bob', description: 'Support' },
    ])
  })

  test('amtp_fetch_peer_card fetches, verifies (TOFU-pinning), and returns the peer card', async () => {
    const agentKeys = generateInstanceKeyPair()
    const sansSig = { v: 1 as const, instanceId: peerInstanceId, handle: 'bob', card: { name: 'Bob' } }
    const signedCard = { ...sansSig, cardSig: signAgentCard(agentKeys.privateKeyPem, sansSig) }

    const ctx = buildCtx(async (url) => {
      const path = new URL(String(url)).pathname
      if (path.endsWith('/card')) return new Response(JSON.stringify(signedCard), { status: 200 })
      if (path.endsWith('/key'))
        return new Response(
          JSON.stringify({ handle: 'bob', instanceId: peerInstanceId, identityPublicKey: agentKeys.publicKeyPem }),
          { status: 200 }
        )
      throw new Error(`unexpected fetch: ${path}`)
    })

    const result = (await findTool('amtp_fetch_peer_card').handler(ctx, {
      peerInstanceId,
      handle: 'bob',
    })) as { ok: boolean; card?: { name?: string }; signedCard?: unknown }
    expect(result.ok).toBe(true)
    expect(result.card?.name).toBe('Bob')
    expect(result.signedCard).toEqual(signedCard)
  })

  test('amtp_fetch_peer_card reports ok:false for an unknown peer', async () => {
    const ctx = buildCtx()
    const result = await findTool('amtp_fetch_peer_card').handler(ctx, { peerInstanceId: 'ghost', handle: 'bob' })
    expect(result).toEqual({ ok: false })
  })

  test('allow rule tools: add, list, remove', () => {
    const ctx = buildCtx()
    const added = findTool('amtp_add_allow_rule').handler(ctx, { handle: 'alice', peer: 'bob-peer' }) as {
      ruleId: string
    }
    expect(added.ruleId).toBeTruthy()

    const listed = findTool('amtp_list_allow_rules').handler(ctx, { handle: 'alice' }) as { ruleId: string }[]
    expect(listed.map((r) => r.ruleId)).toEqual([added.ruleId])

    const removed = findTool('amtp_remove_allow_rule').handler(ctx, { rule_id: added.ruleId })
    expect(removed).toEqual({ removed: true })

    const removedAgain = findTool('amtp_remove_allow_rule').handler(ctx, { rule_id: added.ruleId })
    expect(removedAgain).toEqual({ removed: false })
  })
})
