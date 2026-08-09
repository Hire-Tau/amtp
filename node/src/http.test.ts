// In-process Bun.serve integration tests for the HTTP receive host (§6).
// Every route's happy path AND auth-failure path is covered here, signing
// requests with the protocol/vectors/ golden-vector KEYS (real Ed25519
// signing operations over freshly built bodies/canonical strings, since the
// node mounts routes without the reference host's `/api` prefix — the literal fixture
// signatures in get-canonical.json are pinned to `/api/amtp/...` paths and
// would not verify against this host's `/amtp/...` paths), exactly the way
// packages/amtp-engine/src/verify.test.ts uses the same vector files.
//
// Status/body strings are asserted against the frozen route reference
// (apps/core/src/routes/amtp.ts + apps/core/src/routes/amtp.receive-signed.test.ts):
// 401 → {"error":"Unauthorized"}, 404 → {"error":"Not found"}.
//
// Spec: docs/superpowers/specs/2026-07-08-amtp-node-design.md §6.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Database } from 'bun:sqlite'
import {
  AMTP_HEADER_INSTANCE,
  AMTP_HEADER_SIGNATURE,
  AMTP_HEADER_TIMESTAMP,
  canonicalPeerGetString,
  formatAmtpAddress,
  generateInstanceKeyPair,
  instanceIdFromPublicKeyPem,
  signEnvelope,
} from 'amtp-protocol'
import { buildNodeEngine } from './engine'
import { openDb } from './db/open'
import { blobsDir, dbPath, ensureAmtpDirs } from './home'
import { buildServer } from './http'
import { setCard } from './ops/cards'

const SRC_DIR = dirname(new URL(import.meta.url).pathname)
const VECTORS_DIR = join(SRC_DIR, '..', '..', 'protocol', 'vectors')
const envelopeSig = JSON.parse(readFileSync(join(VECTORS_DIR, 'envelope-signature.json'), 'utf8')) as {
  keys: { publicKeyPem: string; privateKeyPem: string; instanceId: string }
}

// The golden-vector keypair plays the REMOTE PEER's instance identity for
// every signed test below (both the POST /amtp/inbox envelope signature and
// the GET canonical-string signatures) — one real Ed25519 key pair, real
// signing operations, no fabricated signatures.
const PEER_KEYS = envelopeSig.keys
const PEER_INSTANCE_ID = PEER_KEYS.instanceId
const PEER_BASE_URL = 'https://peer.example'

let workDir: string
let home: string
let db: Database
let server: ReturnType<typeof buildServer>
let baseUrl: string
let ourInstanceId: string
const HANDLE = 'billing'
let agentKeys: { publicKeyPem: string; privateKeyPem: string }
let authLogs: Array<[string, string]>

function signGet(path: string, timestampMs: number): string {
  const canonical = canonicalPeerGetString('GET', path, timestampMs)
  return signEnvelope(PEER_KEYS.privateKeyPem, new TextEncoder().encode(canonical))
}

function signedGetHeaders(path: string, timestampMs = Date.now()): Record<string, string> {
  return {
    [AMTP_HEADER_INSTANCE]: PEER_INSTANCE_ID,
    [AMTP_HEADER_SIGNATURE]: signGet(path, timestampMs),
    [AMTP_HEADER_TIMESTAMP]: String(timestampMs),
  }
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'amtp-http-test-'))
  home = join(workDir, 'home')
  ensureAmtpDirs(home)
  db = openDb(dbPath(home))

  const ourKeys = generateInstanceKeyPair()
  ourInstanceId = instanceIdFromPublicKeyPem(ourKeys.publicKeyPem)
  db.run('INSERT INTO identity (id, instance_id, public_key_pem, private_key_pem, created_at) VALUES (1, ?, ?, ?, ?)', [
    ourInstanceId,
    ourKeys.publicKeyPem,
    ourKeys.privateKeyPem,
    Date.now(),
  ])

  agentKeys = generateInstanceKeyPair()
  db.run(
    `INSERT INTO registrations (handle, inbound_open, agent_public_key_pem, agent_private_key_pem, created_at)
     VALUES (?, 1, ?, ?, ?)`,
    [HANDLE, agentKeys.publicKeyPem, agentKeys.privateKeyPem, Date.now()]
  )

  db.run(
    `INSERT INTO peers (instance_id, alias, base_url, public_key_pem, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)`,
    [PEER_INSTANCE_ID, 'test-peer', PEER_BASE_URL, PEER_KEYS.publicKeyPem, Date.now()]
  )

  authLogs = []
  const engine = buildNodeEngine(db, home, { logger: (level, message) => authLogs.push([level, message]) })
  server = buildServer(engine, { hostname: '127.0.0.1', port: 0 })
  baseUrl = `http://127.0.0.1:${server.port}`
})

afterEach(() => {
  server.stop(true)
  db.close()
  rmSync(workDir, { recursive: true, force: true })
})

describe('GET /healthz', () => {
  test('200 {ok:true}, unauthenticated', async () => {
    const res = await fetch(`${baseUrl}/healthz`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })
})

describe('GET /amtp/identity', () => {
  test('200, public bootstrap — no auth required', async () => {
    const res = await fetch(`${baseUrl}/amtp/identity`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { instanceId: string; publicKeyPem: string }
    expect(body.instanceId).toBe(ourInstanceId)
    expect(typeof body.publicKeyPem).toBe('string')
  })
})

describe('POST /amtp/inbox', () => {
  function envelopeBody(overrides: Partial<{ to: string; from: string }> = {}): string {
    const env = {
      v: 1,
      id: randomUUID(),
      ts: Date.now(),
      from: overrides.from ?? formatAmtpAddress(PEER_INSTANCE_ID, 'alice'),
      to: overrides.to ?? formatAmtpAddress(ourInstanceId, HANDLE),
      subject: 'hi',
      content: 'hello from the golden-vector peer',
    }
    return JSON.stringify(env)
  }

  function post(body: string, headers: Record<string, string>) {
    return fetch(`${baseUrl}/amtp/inbox`, { method: 'POST', headers, body })
  }

  test('happy path: 200 {accepted:true} for a fresh signed envelope', async () => {
    const body = envelopeBody()
    const sig = signEnvelope(PEER_KEYS.privateKeyPem, new TextEncoder().encode(body))
    const res = await post(body, { [AMTP_HEADER_INSTANCE]: PEER_INSTANCE_ID, [AMTP_HEADER_SIGNATURE]: sig })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ accepted: true })
  })

  test('replay of the same envelope: 200 {accepted:true, duplicate:true}, no auth failure', async () => {
    const body = envelopeBody()
    const sig = signEnvelope(PEER_KEYS.privateKeyPem, new TextEncoder().encode(body))
    const headers = { [AMTP_HEADER_INSTANCE]: PEER_INSTANCE_ID, [AMTP_HEADER_SIGNATURE]: sig }
    const first = await post(body, headers)
    expect(first.status).toBe(200)
    const second = await post(body, headers)
    expect(second.status).toBe(200)
    expect(await second.json()).toEqual({ accepted: true, duplicate: true })
  })

  test('auth failure: missing signature header → 401 {"error":"Unauthorized"}, body never buffered/parsed', async () => {
    const res = await fetch(`${baseUrl}/amtp/inbox`, {
      method: 'POST',
      headers: { [AMTP_HEADER_INSTANCE]: PEER_INSTANCE_ID },
      body: 'not even json',
    })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Unauthorized' })
  })

  test('auth failure: tampered body after signing → 401 {"error":"Unauthorized"}', async () => {
    const body = envelopeBody()
    const sig = signEnvelope(PEER_KEYS.privateKeyPem, new TextEncoder().encode(body))
    const tampered = body.replace('hello', 'TAMPERED')
    const res = await post(tampered, { [AMTP_HEADER_INSTANCE]: PEER_INSTANCE_ID, [AMTP_HEADER_SIGNATURE]: sig })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Unauthorized' })
  })

  test('unknown recipient handle → 404 (pass-through of the engine reject body)', async () => {
    const body = envelopeBody({ to: formatAmtpAddress(ourInstanceId, 'no-such-handle') })
    const sig = signEnvelope(PEER_KEYS.privateKeyPem, new TextEncoder().encode(body))
    const res = await post(body, { [AMTP_HEADER_INSTANCE]: PEER_INSTANCE_ID, [AMTP_HEADER_SIGNATURE]: sig })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Recipient not found' })
  })
})

describe('GET /amtp/handles', () => {
  test('happy path: signed GET with golden-vector keys → 200 {handles:[...]}', async () => {
    const res = await fetch(`${baseUrl}/amtp/handles`, { headers: signedGetHeaders('/amtp/handles') })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ handles: [{ handle: HANDLE }] })
  })

  test('auth failure: missing timestamp header → 401 {"error":"Unauthorized"}', async () => {
    const headers = signedGetHeaders('/amtp/handles')
    delete (headers as Record<string, string | undefined>)[AMTP_HEADER_TIMESTAMP]
    const res = await fetch(`${baseUrl}/amtp/handles`, { headers })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Unauthorized' })
  })

  test('auth failure: signature over a different path → 401', async () => {
    const ts = Date.now()
    const headers = {
      [AMTP_HEADER_INSTANCE]: PEER_INSTANCE_ID,
      [AMTP_HEADER_SIGNATURE]: signGet('/amtp/some-other-path', ts),
      [AMTP_HEADER_TIMESTAMP]: String(ts),
    }
    const res = await fetch(`${baseUrl}/amtp/handles`, { headers })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Unauthorized' })
  })
})

describe('GET signed-auth wire invariance', () => {
  test('all six local failure reasons have byte-identical 401 responses', async () => {
    const ts = Date.now()
    const unknown = generateInstanceKeyPair()
    const unknownId = instanceIdFromPublicKeyPem(unknown.publicKeyPem)
    const cases: Array<{ reason: string; headers: Record<string, string>; setup?: () => void }> = [
      { reason: 'missing_headers', headers: {} },
      { reason: 'invalid_timestamp', headers: { [AMTP_HEADER_INSTANCE]: PEER_INSTANCE_ID, [AMTP_HEADER_SIGNATURE]: 'bad', [AMTP_HEADER_TIMESTAMP]: 'NaN' } },
      { reason: 'stale_timestamp', headers: signedGetHeaders('/amtp/handles', ts - 400_000) },
      { reason: 'unknown_peer', headers: { [AMTP_HEADER_INSTANCE]: unknownId, [AMTP_HEADER_SIGNATURE]: 'bad', [AMTP_HEADER_TIMESTAMP]: String(ts) } },
      { reason: 'inactive_peer', headers: signedGetHeaders('/amtp/handles', ts), setup: () => db.run("UPDATE peers SET status = 'disabled' WHERE instance_id = ?", [PEER_INSTANCE_ID]) },
      { reason: 'signature_mismatch', headers: { [AMTP_HEADER_INSTANCE]: PEER_INSTANCE_ID, [AMTP_HEADER_SIGNATURE]: signGet('/amtp/other', ts), [AMTP_HEADER_TIMESTAMP]: String(ts) }, setup: () => db.run("UPDATE peers SET status = 'active' WHERE instance_id = ?", [PEER_INSTANCE_ID]) },
    ]
    for (const item of cases) {
      item.setup?.()
      authLogs.length = 0
      const res = await fetch(`${baseUrl}/amtp/handles`, { headers: item.headers })
      expect(res.status).toBe(401)
      expect(res.headers.get('content-type')).toBe('application/json;charset=utf-8')
      expect(await res.text()).toBe('{"error":"Unauthorized"}')
      expect(JSON.parse(authLogs[0][1])).toMatchObject({ event: 'amtp.signed_get_auth_failure', reason: item.reason })
    }
  })

  test('a mounted HTTP host passes the matched route and logs legacy observed-path success', async () => {
    const engine = buildNodeEngine(db, home, { logger: (level, message) => authLogs.push([level, message]) })
    const mounted = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
      const path = new URL(req.url).pathname
      if (path !== '/api/amtp/handles') return new Response('not found', { status: 404 })
      const auth = await engine.verifySignedGet({
        method: 'GET',
        path,
        routePath: '/amtp/handles',
        instanceHeader: req.headers.get(AMTP_HEADER_INSTANCE) ?? undefined,
        signatureHeader: req.headers.get(AMTP_HEADER_SIGNATURE) ?? undefined,
        timestampHeader: req.headers.get(AMTP_HEADER_TIMESTAMP) ?? undefined,
      })
      return auth.ok ? Response.json({ handles: [] }) : Response.json({ error: 'Unauthorized' }, { status: 401 })
    } })
    try {
      authLogs.length = 0
      const ts = Date.now()
      const res = await fetch(`http://127.0.0.1:${mounted.port}/api/amtp/handles`, { headers: signedGetHeaders('/api/amtp/handles', ts) })
      expect(res.status).toBe(200)
      expect(JSON.parse(authLogs[0][1])).toEqual({ event: 'amtp.signed_get_legacy_path_accepted', mode: 'legacy_observed_path', instanceId: PEER_INSTANCE_ID })
    } finally {
      mounted.stop(true)
    }
  })

  test('forwarded path headers never create a verification candidate', async () => {
    const ts = Date.now()
    const res = await fetch(`${baseUrl}/amtp/handles`, { headers: {
      ...signedGetHeaders('/attacker/amtp/handles', ts),
      'x-forwarded-prefix': '/attacker',
      'x-original-uri': '/attacker/amtp/handles',
    } })
    expect(res.status).toBe(401)
    expect(await res.text()).toBe('{"error":"Unauthorized"}')
  })
})

describe('GET /amtp/attachments/:id', () => {
  const attachmentId = 'att-fixture-1'
  const attachmentBytes = new TextEncoder().encode('attachment body bytes')

  beforeEach(() => {
    // Stage a blob file + its metadata row (direction 'out': the wire pull
    // id IS the row id for outbound attachments, §3.1) plus an outbox row
    // addressing it to PEER_INSTANCE_ID, so `hasOutboundAttachmentForPeer`'s
    // default-deny check authorizes exactly this peer for exactly this id.
    writeFileSync(join(blobsDir(home), attachmentId), attachmentBytes)
    db.run(
      `INSERT INTO attachments (id, message_id, direction, filename, content_type, byte_size, sha256, storage_path, created_at)
       VALUES (?, NULL, 'out', 'file.bin', 'application/octet-stream', ?, 'deadbeef', ?, ?)`,
      [attachmentId, attachmentBytes.byteLength, attachmentId, Date.now()]
    )
    const envelopeJson = JSON.stringify({
      v: 1,
      id: randomUUID(),
      ts: Date.now(),
      from: formatAmtpAddress(ourInstanceId, HANDLE),
      to: formatAmtpAddress(PEER_INSTANCE_ID, 'alice'),
      content: 'see attached',
      attachments: [
        {
          id: attachmentId,
          filename: 'file.bin',
          contentType: 'application/octet-stream',
          byteSize: attachmentBytes.byteLength,
          sha256: 'deadbeef',
        },
      ],
    })
    db.run(
      `INSERT INTO outbox (id, peer_instance_id, to_address, envelope_json, idempotency_key, status, attempts, next_attempt_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'delivered', 0, 0, ?, ?)`,
      [
        randomUUID(),
        PEER_INSTANCE_ID,
        formatAmtpAddress(PEER_INSTANCE_ID, 'alice'),
        envelopeJson,
        randomUUID(),
        Date.now(),
        Date.now(),
      ]
    )
  })

  test('happy path: signed GET pull returns 200 raw bytes with content-type/length', async () => {
    const path = `/amtp/attachments/${attachmentId}`
    const res = await fetch(`${baseUrl}${path}`, { headers: signedGetHeaders(path) })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/octet-stream')
    expect(res.headers.get('content-length')).toBe(String(attachmentBytes.byteLength))
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(attachmentBytes)
  })

  test('auth failure: no auth headers at all → 401', async () => {
    const res = await fetch(`${baseUrl}/amtp/attachments/${attachmentId}`)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Unauthorized' })
  })

  test('default-deny: a valid signature but an unaddressed attachment id → 404', async () => {
    const path = '/amtp/attachments/never-addressed-to-this-peer'
    const res = await fetch(`${baseUrl}${path}`, { headers: signedGetHeaders(path) })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Not found' })
  })
})

describe('GET /amtp/agents/:handle/key', () => {
  test('happy path: public, no auth required, 200 with found stripped', async () => {
    const res = await fetch(`${baseUrl}/amtp/agents/${HANDLE}/key`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ handle: HANDLE, instanceId: ourInstanceId, identityPublicKey: agentKeys.publicKeyPem })
    expect(body).not.toHaveProperty('found')
  })

  test('unknown handle → 404 {"error":"Not found"}', async () => {
    const res = await fetch(`${baseUrl}/amtp/agents/no-such-handle/key`)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Not found' })
  })

  test('malformed percent-encoding in handle → 404 {"error":"Not found"}', async () => {
    const res = await fetch(`${baseUrl}/amtp/agents/%/key`)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Not found' })
  })
})

describe('GET /amtp/agents/:handle/card', () => {
  test('serves the published card verbatim, 404 otherwise', async () => {
    const no = await fetch(`${baseUrl}/amtp/agents/${HANDLE}/card`)
    expect(no.status).toBe(404)
    expect(await no.json()).toEqual({ error: 'Not found' })

    const signed = setCard(db, ourInstanceId, { handle: HANDLE, name: 'Alice', description: 'Support' })
    const res = await fetch(`${baseUrl}/amtp/agents/${HANDLE}/card`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(signed)
  })

  test('unknown handle → 404 {"error":"Not found"}', async () => {
    const res = await fetch(`${baseUrl}/amtp/agents/no-such-handle/card`)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Not found' })
  })

  test('malformed percent-encoding in handle → 404 {"error":"Not found"}', async () => {
    const res = await fetch(`${baseUrl}/amtp/agents/%/card`)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Not found' })
  })
})

describe('fallback route', () => {
  test('unmatched path → 404 {"error":"Not found"}', async () => {
    const res = await fetch(`${baseUrl}/not/a/real/route`)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Not found' })
  })
})
