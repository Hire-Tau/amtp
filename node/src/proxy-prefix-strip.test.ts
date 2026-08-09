// REPRODUCTION (not a regression suite): signed GETs (§6.2) fail closed when
// the receiving node sits behind a path-stripping reverse proxy — the ordinary
// way to host a service at `https://host/<prefix>`.
//
// Shape reproduced (observed live, host anonymized as `host`):
//
//   client --GET https://host/tau/amtp/handles--> [proxy strips /tau] --> node
//
//   client signs   "GET\n/tau/amtp/handles\n<ts>"   (pathname of the URL it requests)
//   node verifies  "GET\n/amtp/handles\n<ts>"       (pathname it observes)
//   => signature mismatch => uniform 401, no diagnostic.
//
// Both sides follow §6.2 to the letter; the paragraph defines PATH twice, and
// the two definitions differ by exactly whatever prefix an intermediary strips.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
import { createDefaultAttachmentPull, type AmtpEngine } from 'amtp-engine'
import { openDb } from './db/open'
import { buildNodeEngine } from './engine'
import { blobsDir, dbPath, ensureAmtpDirs } from './home'
import { buildServer } from './http'
import { addPeer } from './ops/peers'

/** The prefix the public URL carries and the proxy strips before forwarding. */
const PROXY_PREFIX = '/tau'

let workDir: string
let receiverDb: Database
let callerDb: Database
let callerEngine: AmtpEngine
let receiverServer: ReturnType<typeof buildServer>
let proxy: ReturnType<typeof Bun.serve>
let directBase: string
let proxiedBase: string
let callerKeys: { publicKeyPem: string; privateKeyPem: string }
let callerInstanceId: string

function initNode(home: string): { db: Database; keys: { publicKeyPem: string; privateKeyPem: string } } {
  ensureAmtpDirs(home)
  const db = openDb(dbPath(home))
  const keys = generateInstanceKeyPair()
  db.run('INSERT INTO identity (id, instance_id, public_key_pem, private_key_pem, created_at) VALUES (1, ?, ?, ?, ?)', [
    instanceIdFromPublicKeyPem(keys.publicKeyPem),
    keys.publicKeyPem,
    keys.privateKeyPem,
    Date.now(),
  ])
  return { db, keys }
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'amtp-proxy-repro-'))

  // Receiver: a node with one registered handle, mounted at the ROOT.
  const receiverHome = join(workDir, 'receiver')
  const receiver = initNode(receiverHome)
  receiverDb = receiver.db
  receiverDb.run(
    `INSERT INTO registrations (handle, inbound_open, agent_public_key_pem, agent_private_key_pem, created_at)
     VALUES (?, 1, ?, ?, ?)`,
    ['billing', generateInstanceKeyPair().publicKeyPem, generateInstanceKeyPair().privateKeyPem, Date.now()]
  )
  receiverServer = buildServer(buildNodeEngine(receiverDb, receiverHome), { hostname: '127.0.0.1', port: 0 })
  directBase = `http://127.0.0.1:${receiverServer.port}`

  // Caller: a second node, peered with the receiver (and vice versa).
  const callerHome = join(workDir, 'caller')
  const caller = initNode(callerHome)
  callerDb = caller.db
  callerKeys = caller.keys
  callerInstanceId = instanceIdFromPublicKeyPem(callerKeys.publicKeyPem)
  callerEngine = buildNodeEngine(callerDb, callerHome)
  addPeer(receiverDb, { alias: 'caller', baseUrl: 'http://caller.invalid', publicKeyPem: callerKeys.publicKeyPem })

  // The path-stripping reverse proxy: everything under `${PROXY_PREFIX}/...`
  // is forwarded to the node with the prefix removed. This is what nginx
  // `location /tau/ { proxy_pass http://node/; }`, Caddy `handle_path`, or a
  // Traefik StripPrefix middleware do — the standard way to host an app at a
  // sub-path.
  proxy = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (!url.pathname.startsWith(`${PROXY_PREFIX}/`)) return new Response('not found', { status: 404 })
      const stripped = url.pathname.slice(PROXY_PREFIX.length)
      return fetch(`${directBase}${stripped}${url.search}`, { method: req.method, headers: req.headers })
    },
  })
  proxiedBase = `http://127.0.0.1:${proxy.port}${PROXY_PREFIX}`
})

afterEach(() => {
  proxy.stop(true)
  receiverServer.stop(true)
  receiverDb.close()
  callerDb.close()
  rmSync(workDir, { recursive: true, force: true })
})

test('control: signed GET /amtp/handles succeeds when the client talks to the node directly', async () => {
  const result = await callerEngine.fetchPeerHandles({ peerBaseUrl: directBase })
  expect(result).toEqual({ ok: true, handles: [{ handle: 'billing' }] })
})

test('signed GET succeeds through a path-stripping proxy', async () => {
  const result = await callerEngine.fetchPeerHandles({ peerBaseUrl: proxiedBase })
  expect(result).toEqual({ ok: true, handles: [{ handle: 'billing' }] })
})

test('route-relative signing authenticates while legacy stripped-prefix spelling stays denied', async () => {
  const ts = Date.now()
  const requestUrl = `${proxiedBase}/amtp/handles`

  // What the CLIENT signs: "the pathname of the full URL it requests" (§6.2).
  const clientPath = new URL(requestUrl).pathname
  // What the SERVER verifies: "the full request pathname as the server
  // observes it" (§6.2) — the proxy already removed the prefix.
  const serverPath = clientPath.slice(PROXY_PREFIX.length)

  expect(clientPath).toBe('/tau/amtp/handles')
  expect(serverPath).toBe('/amtp/handles')
  expect(canonicalPeerGetString('GET', clientPath, ts)).not.toBe(canonicalPeerGetString('GET', serverPath, ts))

  const signature = signEnvelope(
    callerKeys.privateKeyPem,
    new TextEncoder().encode(canonicalPeerGetString('GET', serverPath, ts))
  )
  const res = await fetch(requestUrl, {
    headers: {
      [AMTP_HEADER_INSTANCE]: callerInstanceId,
      [AMTP_HEADER_SIGNATURE]: signature,
      [AMTP_HEADER_TIMESTAMP]: String(ts),
    },
  })

  expect(res.status).toBe(200)

  // Proof the failure is the path and nothing else: signing the path the
  // server observes verifies — but no conformant client can produce it, since
  // §6.2 tells the client to sign the URL it requests, and the prefix the
  // proxy strips is not knowable from that URL.
  const serverSideSignature = signEnvelope(
    callerKeys.privateKeyPem,
    new TextEncoder().encode(canonicalPeerGetString('GET', clientPath, ts))
  )
  const res2 = await fetch(requestUrl, {
    headers: {
      [AMTP_HEADER_INSTANCE]: callerInstanceId,
      [AMTP_HEADER_SIGNATURE]: serverSideSignature,
      [AMTP_HEADER_TIMESTAMP]: String(ts),
    },
  })
  expect(res2.status).toBe(401)
  expect(await res2.text()).toBe('{"error":"Unauthorized"}')
})

test('route-relative attachment auth passes through the stripping proxy', async () => {
  const ts = Date.now()
  const requestUrl = `${proxiedBase}/amtp/attachments/att-does-not-exist`
  const signature = signEnvelope(
    callerKeys.privateKeyPem,
    new TextEncoder().encode(canonicalPeerGetString('GET', '/amtp/attachments/att-does-not-exist', ts))
  )
  const res = await fetch(requestUrl, {
    headers: {
      [AMTP_HEADER_INSTANCE]: callerInstanceId,
      [AMTP_HEADER_SIGNATURE]: signature,
      [AMTP_HEADER_TIMESTAMP]: String(ts),
    },
  })
  // 404 proves authentication passed and only the resource gate denied it.
  expect(res.status).toBe(404)
})


test('authorized attachment bytes pull successfully through the stripping proxy', async () => {
  const id = 'proxy-blob'
  const bytes = new TextEncoder().encode('proxy attachment bytes')
  const sha256 = new Bun.CryptoHasher('sha256').update(bytes).digest('hex')
  writeFileSync(join(blobsDir(join(workDir, 'receiver')), id), bytes)
  receiverDb.run(`INSERT INTO attachments (id, message_id, direction, filename, content_type, byte_size, sha256, storage_path, created_at) VALUES (?, NULL, 'out', 'blob.bin', 'application/octet-stream', ?, ?, ?, ?)`, [id, bytes.length, sha256, id, Date.now()])
  const receiverIdentity = (receiverDb.query('SELECT instance_id FROM identity WHERE id = 1').get() as { instance_id: string }).instance_id
  const envelope = { v: 1, id: randomUUID(), ts: Date.now(), from: formatAmtpAddress(receiverIdentity, 'billing'), to: formatAmtpAddress(callerInstanceId, 'alice'), content: 'attached', attachments: [{ id, filename: 'blob.bin', contentType: 'application/octet-stream', byteSize: bytes.length, sha256 }] }
  receiverDb.run(`INSERT INTO outbox (id, peer_instance_id, to_address, envelope_json, idempotency_key, status, attempts, next_attempt_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'delivered', 0, 0, ?, ?)`, [randomUUID(), callerInstanceId, envelope.to, JSON.stringify(envelope), randomUUID(), Date.now(), Date.now()])
  const pull = createDefaultAttachmentPull({ signing: async () => ({ instanceId: callerInstanceId, privateKeyPem: callerKeys.privateKeyPem }), getCaps: async () => ({ maxAttachmentBytes: 1000, maxTotalAttachmentBytes: 1000, maxTotalStorageBytes: 1000 }) })
  await expect(pull({ peerBaseUrl: proxiedBase, ref: envelope.attachments[0] })).resolves.toEqual(bytes)
})
