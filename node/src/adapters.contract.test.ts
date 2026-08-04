// Runs amtp-engine's contract-test kit (§4.12 in the engine spec; §10.4 in
// this node's design doc) against the real sqlite adapters + delivery hooks
// in this package, over a fresh temp-home `amtp.db` per test.
//
// Several suites use identifiers that are opaque to the ENGINE but must be
// real, FK-valid rows in the node's schema (e.g. `recipientRef: 'agent-1'`
// is not necessarily a real handle). Where that happens, this file's
// `make()` factories wrap the real adapter behind a thin translation/seeding
// shim, exactly the pattern the original contract-kit runner established
// (apps/core/src/services/amtp/adapters.contract.test.ts) — the logic under
// test is always this package's real adapter, never a fake.
import { afterEach, beforeEach, describe, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'bun:sqlite'
import { contractKit } from 'amtp-engine'
import {
  buildAttachmentStore,
  buildHandleDirectory,
  buildOutboxStore,
  buildPeerStore,
  buildPinStore,
  buildReceivePolicy,
  buildReplayLedger,
} from './adapters'
import { writeBlobDurable } from './blobs'
import { openDb } from './db/open'
import { buildDeliveryHooks } from './hooks'
import { ensureAmtpDirs } from './home'

const t = { describe, test }

let workDir: string
let home: string
let db: Database

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'amtp-adapters-contract-'))
  home = join(workDir, 'home')
  ensureAmtpDirs(home)
  db = openDb(join(workDir, 'amtp.db'))
})

afterEach(() => {
  db.close()
  rmSync(workDir, { recursive: true, force: true })
})

function registerHandle(handle: string): void {
  db.run(
    `INSERT OR IGNORE INTO registrations (handle, inbound_open, agent_public_key_pem, agent_private_key_pem, created_at)
     VALUES (?, 0, 'unused-pub-key', 'unused-priv-key', ?)`,
    [handle, Date.now()]
  )
}

// ---------------------------------------------------------------------------
// PeerStore (§4.2)
// ---------------------------------------------------------------------------
contractKit.runPeerStoreContract(t, async () => ({
  store: buildPeerStore(db),
  seed: (instanceId, peer) => {
    db.run(
      `INSERT INTO peers (instance_id, alias, base_url, public_key_pem, status, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [instanceId, instanceId, peer.baseUrl, peer.publicKeyPem, peer.status, Date.now()]
    )
  },
}))

// ---------------------------------------------------------------------------
// PinStore (§4.3)
// ---------------------------------------------------------------------------
contractKit.runPinStoreContract(t, async () => buildPinStore(db))

// ---------------------------------------------------------------------------
// ReplayLedger (§4.4)
// ---------------------------------------------------------------------------
contractKit.runReplayLedgerContract(t, async () => buildReplayLedger(db))

// ---------------------------------------------------------------------------
// OutboxStore (§4.5)
// ---------------------------------------------------------------------------
contractKit.runOutboxStoreContract(t, async () => buildOutboxStore(db))

// ---------------------------------------------------------------------------
// AttachmentStore (§4.6) — `attachments.id` is a free-form TEXT PK, so the
// kit's synthetic attachment ids can be used directly as the real row id
// (no translation map needed, unlike a host with a uuid-typed column).
//
// `seedBlob` inserts `direction='out'`: `readOutboundBlob` (the method this
// contract exercises) is the sender-side serve read for `serveAttachment`
// (§5.5) — it must only ever resolve locally-staged OUTBOUND attachments,
// never blobs received FROM a peer (`direction='in'`), so the real query
// filters `AND direction='out'` (defense-in-depth: an inbound blob's id
// must never be servable to an arbitrary pulling peer).
// ---------------------------------------------------------------------------
contractKit.runAttachmentStoreContract(t, async () => ({
  store: buildAttachmentStore(db, home),
  seedBlob: (attachmentId, blob) => {
    writeBlobDurable(home, attachmentId, blob.bytes)
    db.run(
      `INSERT INTO attachments (id, message_id, direction, filename, content_type, byte_size, sha256, storage_path, created_at)
       VALUES (?, NULL, 'out', ?, ?, ?, ?, ?, ?)`,
      [attachmentId, `${attachmentId}.bin`, blob.contentType, blob.byteSize, 'x'.repeat(64), attachmentId, Date.now()]
    )
  },
  seedStoredBytes: (bytes) => {
    db.run(
      `INSERT INTO attachments (id, message_id, direction, filename, content_type, byte_size, sha256, storage_path, created_at)
       VALUES (?, NULL, 'in', 'seed-bytes.bin', 'application/octet-stream', ?, ?, '', ?)`,
      [randomUUID(), bytes, 'x'.repeat(64), Date.now()]
    )
  },
}))

// ---------------------------------------------------------------------------
// HandleDirectory (§4.7) — recipientRef translation shim: the kit seeds
// records whose recipientRef need not equal the handle, while the node's
// real `resolve` always returns the handle itself (§4.7 — recipientRef IS
// the handle for this host).
// ---------------------------------------------------------------------------
contractKit.runHandleDirectoryContract(t, async () => {
  const directory = buildHandleDirectory(db)
  const handleToToken = new Map<string, string>()
  const seededHandles = new Set<string>()

  return {
    directory: {
      resolve: async (handle) => {
        const real = await directory.resolve(handle)
        if (!real) return null
        return {
          recipientRef: handleToToken.get(handle) ?? real.recipientRef,
          inboundOpen: real.inboundOpen,
          agentPublicKeyPem: real.agentPublicKeyPem,
        }
      },
      // Filtered to this test's own seeded handles, mirroring the reference runner:
      // insulates the exact-equality assertion from any noise, without
      // masking a real exclusion bug (seedTerminated does not remove its
      // handle from `seededHandles`).
      list: async () => (await directory.list()).filter((h) => seededHandles.has(h.handle)),
      getCard: (handle) => directory.getCard(handle),
    },
    seed: (handle, record) => {
      db.run(
        `INSERT INTO registrations (handle, inbound_open, agent_public_key_pem, agent_private_key_pem, created_at)
         VALUES (?, ?, ?, 'unused-priv-key', ?)`,
        [handle, record.inboundOpen ? 1 : 0, record.agentPublicKeyPem ?? 'unused-pub-key', Date.now()]
      )
      handleToToken.set(handle, record.recipientRef)
      seededHandles.add(handle)
    },
    seedTerminated: (handle) => {
      db.run('DELETE FROM registrations WHERE handle = ?', [handle])
    },
    seedCard: (handle, signedCard) => {
      db.run('UPDATE registrations SET card_json = ? WHERE handle = ?', [JSON.stringify(signedCard), handle])
    },
  }
})

// ---------------------------------------------------------------------------
// ReceivePolicy (§4.8) — the allow-rule-matching leakage target. The kit
// hardcodes `recipientRef: 'agent-1'`, which the node's `allow_rules.handle`
// FK requires to exist as a real registration.
// ---------------------------------------------------------------------------
contractKit.runReceivePolicyContract(t, async () => ({
  policy: buildReceivePolicy(db, home),
  seed: (recipientRef, rule) => {
    registerHandle(recipientRef)
    db.run(
      `INSERT INTO allow_rules (id, handle, peer_instance_id, principal_kind, principal_value, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [randomUUID(), recipientRef, rule.peerInstanceId, rule.principalKind, rule.principalValue ?? null, Date.now()]
    )
  },
}))

// ---------------------------------------------------------------------------
// DeliveryHooks (§4.9) — the rollback leakage target. The kit hardcodes
// `recipientRef: 'agent-1'`, which `messages.handle`'s FK requires to exist
// — seeded once per `make()` call. `failAfterAttachments` is implemented via
// the hook's injectable `writeBlob` seam (src/hooks.ts), which throws after
// N successful writes instead of relying on any real quota mechanism.
// ---------------------------------------------------------------------------
contractKit.runDeliveryHooksContract(t, async (opts) => {
  registerHandle('agent-1')

  let writes = 0
  const hooks = buildDeliveryHooks(db, home, {
    writeBlob:
      opts?.failAfterAttachments === undefined
        ? undefined
        : (blobHome, finalId, data) => {
            if (writes >= opts.failAfterAttachments!) {
              throw new Error(`injected write failure after ${opts.failAfterAttachments} attachment(s)`)
            }
            writes += 1
            writeBlobDurable(blobHome, finalId, data)
          },
  })

  return {
    hooks,
    probes: {
      hasMessage: (envelopeId) => {
        const row = db
          .query<{ one: number }, [string]>('SELECT 1 AS one FROM messages WHERE envelope_id = ? LIMIT 1')
          .get(envelopeId)
        return !!row
      },
      // Inbound rows get a fresh LOCAL uuid (C1, §4.9) — the kit's probe
      // receives the WIRE ref id, so match by filename (the kit's fixtures
      // name blobs `${refId}.bin`), matching the established reference probe.
      hasAttachmentBlob: (attachmentId) => {
        const row = db
          .query<{ one: number }, [string]>('SELECT 1 AS one FROM attachments WHERE filename = ? LIMIT 1')
          .get(`${attachmentId}.bin`)
        return !!row
      },
    },
  }
})
