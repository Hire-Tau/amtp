// In-memory port fakes (§4.12) — shared by this package's own unit tests
// (receive.test.ts, outbox.test.ts, serve.test.ts) AND by hosts that want a
// quick fake to run the contract-test kit (../contract-kit) against, or to
// use in their own test suites. Exported from the package root (§1) as the
// `testing` namespace.
import { randomUUID } from 'node:crypto'
import type { AmtpSignedAgentCard } from 'amtp-protocol'
import { matchesAllowRule } from '../allow-rule'
import type {
  AttachmentStore,
  DeliveryHooks,
  HandleDirectory,
  InstanceIdentityPort,
  OutboxEntry,
  OutboxStore,
  PeerStore,
  PinStore,
  ReceiveCaps,
  ReceivePolicy,
  ReplayLedger,
} from '../ports'

// ---------------------------------------------------------------------------
// §4.1 InstanceIdentityPort
// ---------------------------------------------------------------------------

export function makeIdentity(instanceId: string, publicKeyPem: string, privateKeyPem: string): InstanceIdentityPort {
  return {
    async get() {
      return { instanceId, publicKeyPem, privateKeyPem }
    },
    async getSigning() {
      return { instanceId, privateKeyPem }
    },
  }
}

// ---------------------------------------------------------------------------
// §4.2 PeerStore
// ---------------------------------------------------------------------------

export interface FakePeerStore extends PeerStore {
  set(id: string, v: { baseUrl: string; publicKeyPem: string; status: string }): void
  delete(id: string): void
}

export function makePeerStore(): FakePeerStore {
  const map = new Map<string, { baseUrl: string; publicKeyPem: string; status: string }>()
  return {
    async getPeer(id) {
      return map.get(id) ?? null
    },
    set(id, v) {
      map.set(id, v)
    },
    delete(id) {
      map.delete(id)
    },
  }
}

/** A PeerStore that answers with `peer` for the first `okCalls` calls, then null —
 *  simulates the peer disappearing mid-receive (§4.2: getPeer may be called
 *  several times within one receiveEnvelope; the engine does not cache it). */
export function makeFlakyPeerStore(
  peer: { baseUrl: string; publicKeyPem: string; status: string },
  okCalls: number
): PeerStore {
  let calls = 0
  return {
    async getPeer() {
      calls += 1
      return calls <= okCalls ? peer : null
    },
  }
}

// ---------------------------------------------------------------------------
// §4.3 PinStore (TOFU)
// ---------------------------------------------------------------------------

export interface FakePinStore extends PinStore {
  pins: Map<string, string>
}

export function makePinStore(): FakePinStore {
  const pins = new Map<string, string>()
  return {
    pins,
    async getPin(peer, handle) {
      return pins.get(`${peer}:${handle}`) ?? null
    },
    async recordPinIfNew(peer, handle, key) {
      const k = `${peer}:${handle}`
      if (!pins.has(k)) pins.set(k, key)
      return pins.get(k) as string
    },
  }
}

// ---------------------------------------------------------------------------
// §4.5 ReplayLedger
// ---------------------------------------------------------------------------

export interface FakeReplayLedger extends ReplayLedger {
  seen: Set<string>
}

export function makeReplayLedger(): FakeReplayLedger {
  const seen = new Set<string>()
  return {
    seen,
    async recordIfNew(peer, id) {
      const k = `${peer}:${id}`
      if (seen.has(k)) return false
      seen.add(k)
      return true
    },
    async unrecord(peer, id) {
      seen.delete(`${peer}:${id}`)
    },
  }
}

// ---------------------------------------------------------------------------
// §4.6 OutboxStore
// ---------------------------------------------------------------------------

export interface FakeOutboxStore extends OutboxStore {
  rows: Map<string, OutboxEntry>
  markDeliveredCalls: Array<{ id: string; claimToken: string }>
  markRetryCalls: Array<{ id: string; claimToken: string; error: string }>
  markFailedTerminalCalls: Array<{ id: string; claimToken: string; error: string }>
}

/** `returnFalseFromMarkers` simulates a stale-reclaim race (§4.6): the marker
 *  boolean is false, but the engine must still count + act on its OWN
 *  classification (§5.10) — it never consults this boolean.
 *
 *  `authorizedAttachmentsFor` seeds `hasOutboundAttachmentForPeer` (§5.5's
 *  default-deny serve check) independently of the queued rows.
 *
 *  Claim semantics (§4.6): a never-claimed row is claimable immediately and
 *  KEEPS whatever `claimToken` the caller pre-seeded on it (fixture
 *  convenience — real hosts never see a non-null claimToken on an unclaimed
 *  row, since `enqueue` always starts one at null); a row already claimed and
 *  not yet stale is excluded; a stale-claimed row (claimed longer than
 *  `staleMs` ago) is reclaimed with a FRESH claimToken, per "each claim CALL
 *  stamps a fresh claimToken." All three markers gate on the claimToken
 *  matching the row's CURRENT claimToken — a mismatch is a no-op (`false`),
 *  modeling the zombie-worker guard. */
export function makeOutboxStore(
  rows: OutboxEntry[] = [],
  opts: {
    returnFalseFromMarkers?: boolean
    authorizedAttachmentsFor?: Map<string, Set<string>>
  } = {}
): FakeOutboxStore {
  const rowMap = new Map(rows.map((r) => [r.id, r]))
  // idempotencyKey -> entry id, populated by enqueue() below (§9.1 conflict detection).
  const idempotencyMap = new Map<string, string>()
  // id -> ms timestamp of the row's last claim; absent = never claimed (or released back to pending).
  const claimedAt = new Map<string, number>()
  // id -> ms timestamp before which a retried-but-pending row is NOT yet
  // claimable (§3.3 reference backoff formula, applied by markRetry below);
  // absent = ready now (never retried, or backoff already elapsed).
  const readyAt = new Map<string, number>()
  const markDeliveredCalls: FakeOutboxStore['markDeliveredCalls'] = []
  const markRetryCalls: FakeOutboxStore['markRetryCalls'] = []
  const markFailedTerminalCalls: FakeOutboxStore['markFailedTerminalCalls'] = []

  return {
    rows: rowMap,
    markDeliveredCalls,
    markRetryCalls,
    markFailedTerminalCalls,
    async enqueue(input) {
      const existingId = idempotencyMap.get(input.idempotencyKey)
      const existing = existingId ? rowMap.get(existingId) : undefined
      if (existing) return existing
      const entry: OutboxEntry = {
        id: randomUUID(),
        peerInstanceId: input.peerInstanceId,
        toAddress: input.toAddress,
        envelope: input.envelope,
        attempts: 0,
        claimToken: null,
      }
      rowMap.set(entry.id, entry)
      idempotencyMap.set(input.idempotencyKey, entry.id)
      return entry
    },
    async claimBatch(limit, staleMs) {
      const now = Date.now()
      const claimed: OutboxEntry[] = []
      for (const entry of rowMap.values()) {
        if (claimed.length >= limit) break
        const lastClaim = claimedAt.get(entry.id)
        const isPending = lastClaim === undefined
        const isStale = lastClaim !== undefined && now - lastClaim > staleMs
        if (!isPending && !isStale) continue
        if (isPending) {
          const due = readyAt.get(entry.id)
          if (due !== undefined && now < due) continue // still backing off (§3.3)
        }
        entry.claimToken = isPending && entry.claimToken ? entry.claimToken : randomUUID()
        claimedAt.set(entry.id, now)
        readyAt.delete(entry.id)
        // Return a snapshot, not the live row reference — a caller holding a
        // claimed entry across a LATER claimBatch call (e.g. one that
        // stale-reclaims the same row) must not see its copy mutated out
        // from under it.
        claimed.push({ ...entry })
      }
      return claimed
    },
    async markDelivered(id, claimToken) {
      markDeliveredCalls.push({ id, claimToken })
      const entry = rowMap.get(id)
      if (!entry || entry.claimToken !== claimToken) return false
      if (opts.returnFalseFromMarkers) return false
      rowMap.delete(id)
      claimedAt.delete(id)
      return true
    },
    async markRetry(id, claimToken, error) {
      markRetryCalls.push({ id, claimToken, error })
      const entry = rowMap.get(id)
      if (!entry || entry.claimToken !== claimToken) return false
      if (opts.returnFalseFromMarkers) return false
      // §3.3 reference backoff formula, computed against the PRE-increment
      // attempts value: min(5000 · 2^min(attempts+1, 16), 300000) ms.
      const backoffMs = Math.min(5000 * 2 ** Math.min(entry.attempts + 1, 16), 300_000)
      readyAt.set(id, Date.now() + backoffMs)
      entry.attempts += 1
      claimedAt.delete(id) // back to pending — reclaimable once backoff elapses
      return true
    },
    async markFailedTerminal(id, claimToken, error) {
      markFailedTerminalCalls.push({ id, claimToken, error })
      const entry = rowMap.get(id)
      if (!entry || entry.claimToken !== claimToken) return false
      if (opts.returnFalseFromMarkers) return false
      rowMap.delete(id)
      claimedAt.delete(id)
      return true
    },
    async hasOutboundAttachmentForPeer(peerInstanceId, attachmentId) {
      return opts.authorizedAttachmentsFor?.get(peerInstanceId)?.has(attachmentId) ?? false
    },
  }
}

// ---------------------------------------------------------------------------
// §4.7 AttachmentStore
// ---------------------------------------------------------------------------

export interface FakeAttachmentStore extends AttachmentStore {
  blobs: Map<string, { bytes: Uint8Array; contentType: string; byteSize: number }>
  setStoredBytes(bytes: number): void
}

export function makeAttachmentStore(
  opts: {
    storedBytes?: number
    blobs?: Map<string, { bytes: Uint8Array; contentType: string; byteSize: number }>
  } = {}
): FakeAttachmentStore {
  const blobs = opts.blobs ?? new Map()
  let storedBytes = opts.storedBytes ?? 0
  return {
    blobs,
    setStoredBytes(bytes) {
      storedBytes = bytes
    },
    async totalStoredBytes() {
      return storedBytes
    },
    async readOutboundBlob(attachmentId) {
      return blobs.get(attachmentId) ?? null
    },
  }
}

// ---------------------------------------------------------------------------
// §4.8 HandleDirectory
// ---------------------------------------------------------------------------

export interface FakeHandleDirectory extends HandleDirectory {
  set(handle: string, v: { recipientRef: string; inboundOpen: boolean; agentPublicKeyPem: string | null }): void
  setCard(handle: string, signedCard: AmtpSignedAgentCard): void
  /** Remove a handle — models a terminated/unregistered agent (§4.8: resolve
   *  MUST only return live registrations) for the contract kit's optional
   *  `seedTerminated` probe. */
  delete(handle: string): void
}

export function makeHandleDirectory(): FakeHandleDirectory {
  const map = new Map<string, { recipientRef: string; inboundOpen: boolean; agentPublicKeyPem: string | null }>()
  const cards = new Map<string, AmtpSignedAgentCard>()
  return {
    async resolve(h) {
      return map.get(h) ?? null
    },
    async list() {
      return [...map.keys()].sort().map((handle) => {
        const card = cards.get(handle)?.card
        return {
          handle,
          ...(card?.name ? { name: card.name } : {}),
          ...(card?.description ? { description: card.description } : {}),
        }
      })
    },
    async getCard(h) {
      return cards.get(h) ?? null
    },
    set(h, v) {
      map.set(h, v)
    },
    setCard(h, c) {
      cards.set(h, c)
    },
    delete(h) {
      map.delete(h)
      cards.delete(h)
    },
  }
}

// ---------------------------------------------------------------------------
// §4.9 ReceivePolicy
// ---------------------------------------------------------------------------

export interface AllowRule {
  peerInstanceId: string
  principalKind: 'any' | 'handle'
  principalValue?: string | null
}

export interface FakeReceivePolicy extends ReceivePolicy {
  /** Seed an allow-rule for `recipientRef` (§4.9), evaluated via the exported
   *  reference matcher `matchesAllowRule` — backs the contract kit's
   *  `runReceivePolicyContract` seed hook. Only consulted when this fake was
   *  constructed WITHOUT `opts.allow` (the constant-answer mode below stays
   *  in force otherwise, preserving existing callers). */
  seedRule(recipientRef: string, rule: AllowRule): void
}

export function makeReceivePolicy(opts: { allow?: boolean; caps?: ReceiveCaps } = {}): FakeReceivePolicy {
  const caps = opts.caps ?? {
    maxAttachmentBytes: Number.POSITIVE_INFINITY,
    maxTotalStorageBytes: Number.POSITIVE_INFINITY,
  }
  const rulesByRecipient = new Map<string, AllowRule[]>()
  return {
    seedRule(recipientRef, rule) {
      const rules = rulesByRecipient.get(recipientRef) ?? []
      rules.push(rule)
      rulesByRecipient.set(recipientRef, rules)
    },
    async isReceiveAllowed({ recipientRef, peerInstanceId, senderHandle }) {
      if (opts.allow !== undefined) return opts.allow
      const rules = rulesByRecipient.get(recipientRef) ?? []
      return rules.some((rule) => matchesAllowRule(rule, { peerInstanceId, senderHandle }))
    },
    async getReceiveCaps() {
      return caps
    },
  }
}

// ---------------------------------------------------------------------------
// §4.10 DeliveryHooks
// ---------------------------------------------------------------------------

export interface FakeDeliveryHooks extends DeliveryHooks {
  // biome-ignore lint: test fake, args typed by DeliveryHooks itself
  messageReceivedCalls: Array<Parameters<DeliveryHooks['onMessageReceived']>[0]>
  // biome-ignore lint: test fake, args typed by DeliveryHooks itself
  deliveryFailedCalls: Array<Parameters<DeliveryHooks['onDeliveryFailed']>[0]>
}

export function makeDeliveryHooks(
  opts: {
    onMessageReceived?: DeliveryHooks['onMessageReceived']
    onDeliveryFailed?: DeliveryHooks['onDeliveryFailed']
  } = {}
): FakeDeliveryHooks {
  const messageReceivedCalls: FakeDeliveryHooks['messageReceivedCalls'] = []
  const deliveryFailedCalls: FakeDeliveryHooks['deliveryFailedCalls'] = []
  return {
    messageReceivedCalls,
    deliveryFailedCalls,
    async onMessageReceived(args) {
      messageReceivedCalls.push(args)
      if (opts.onMessageReceived) await opts.onMessageReceived(args)
    },
    async onDeliveryFailed(args) {
      deliveryFailedCalls.push(args)
      if (opts.onDeliveryFailed) await opts.onDeliveryFailed(args)
    },
  }
}

/** A rollback-aware DeliveryHooks fake for the contract kit's rollback probes
 *  (§4.12): `onMessageReceived` persists attachment blobs one at a time and,
 *  when `failAfterAttachments` is reached, throws AFTER rolling back every
 *  blob it had already written this call — modeling the §4.10 contract that a
 *  throw MUST leave no host-visible partial state. */
export interface RollbackAwareDeliveryHooks extends DeliveryHooks {
  probes: {
    hasMessage: (envelopeId: string) => boolean
    hasAttachmentBlob: (attachmentId: string) => boolean
  }
}

export function makeDeliveryHooksWithRollback(
  opts: { failAfterAttachments?: number } = {}
): RollbackAwareDeliveryHooks {
  const messages = new Set<string>()
  const attachmentBlobs = new Map<string, Uint8Array>()
  return {
    probes: {
      hasMessage: (envelopeId) => messages.has(envelopeId),
      hasAttachmentBlob: (attachmentId) => attachmentBlobs.has(attachmentId),
    },
    async onMessageReceived({ envelope, attachments }) {
      const persisted: string[] = []
      try {
        for (const [i, att] of attachments.entries()) {
          if (opts.failAfterAttachments !== undefined && i >= opts.failAfterAttachments) {
            throw new Error('simulated mid-persist failure')
          }
          attachmentBlobs.set(att.ref.id, att.bytes)
          persisted.push(att.ref.id)
        }
        messages.add(envelope.id)
      } catch (err) {
        for (const id of persisted) attachmentBlobs.delete(id)
        throw err
      }
    },
    async onDeliveryFailed() {},
  }
}
