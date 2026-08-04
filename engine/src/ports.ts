import type { AmtpAttachmentRef, AmtpEnvelope, AmtpSignedAgentCard } from 'amtp-protocol'

// ---------------------------------------------------------------------------
// §3.2 Shared engine port types
// ---------------------------------------------------------------------------

/** The engine's read view of a queued envelope. Hosts may store more columns. */
export interface OutboxEntry {
  id: string
  peerInstanceId: string
  toAddress: string
  envelope: AmtpEnvelope
  /** Completed attempts so far. */
  attempts: number
  /** Non-null on entries returned by claimBatch. */
  claimToken: string | null
}

export interface ReceiveCaps {
  /** Per-attachment byte cap. Non-finite (NaN/Infinity) disables the check —
   *  mirrors the Number.isFinite guard at services/amtp/attachment-pull.ts:30-33. */
  maxAttachmentBytes: number
  /** Aggregate stored-bytes quota. Non-finite/NaN disables (comparison is
   *  `existing + incoming > cap`, exactly routes/amtp.ts:506-509). */
  maxTotalStorageBytes: number
}

// ---------------------------------------------------------------------------
// §4.1 InstanceIdentityPort
// ---------------------------------------------------------------------------

/** Signing view: everything an outbound network op needs. May legitimately lack
 *  the public key (test signers may supply only these two fields). */
export interface SigningIdentity {
  instanceId: string
  privateKeyPem: string
}

export interface InstanceIdentityPort {
  /** FULL identity. MUST be stable for the process lifetime; MUST
   *  create-on-first-use or fail loudly (never return a partial identity).
   *  instanceId MUST equal the AMTP.md §4.1 derivation of publicKeyPem. This
   *  self-certification MUST applies to THIS method only. */
  get(): Promise<{ instanceId: string; publicKeyPem: string; privateKeyPem: string }>
  /** Signing view for outbound operations. Usually the subset of get(), but
   *  independently overridable (host signer seams may inject exactly this
   *  shape) — the derivation MUST above does NOT apply here. */
  getSigning(): Promise<SigningIdentity>
}

// ---------------------------------------------------------------------------
// §4.2 PeerStore
// ---------------------------------------------------------------------------

export interface PeerStore {
  /** Look up a trusted peer by instance id. Returns null when unknown.
   *  `status` is an opaque string; the engine compares it only against 'active'. */
  getPeer(instanceId: string): Promise<{
    baseUrl: string
    publicKeyPem: string
    status: string
  } | null>
}

// ---------------------------------------------------------------------------
// §4.3 PinStore (TOFU)
// ---------------------------------------------------------------------------

export interface PinStore {
  /** Pinned agent public key PEM for (peer, handle), or null if never pinned. */
  getPin(peerInstanceId: string, handle: string): Promise<string | null>
  /** Record `publicKeyPem` as the pin iff none exists. MUST be idempotent and
   *  race-safe: under concurrent first contact the FIRST-SEEN pin wins and is
   *  returned; the method always returns the winning (stored) pin. */
  recordPinIfNew(peerInstanceId: string, handle: string, publicKeyPem: string): Promise<string>
}

// ---------------------------------------------------------------------------
// §4.5 ReplayLedger
// ---------------------------------------------------------------------------

export interface ReplayLedger {
  /** Atomically record (peer, envelopeId). True iff first sighting (row inserted);
   *  false when already recorded. MUST be a single atomic insert-if-absent. */
  recordIfNew(peerInstanceId: string, envelopeId: string): Promise<boolean>
  /** Release the slot so a sender retry is a fresh first sighting. Idempotent;
   *  MUST NOT throw when the record is already gone. */
  unrecord(peerInstanceId: string, envelopeId: string): Promise<void>
}

// ---------------------------------------------------------------------------
// §4.6 OutboxStore
// ---------------------------------------------------------------------------

export interface OutboxStore {
  /** Insert; on idempotencyKey conflict return the EXISTING entry (idempotent
   *  enqueue, §9.1). The stored envelope/id MUST never change on re-enqueue. */
  enqueue(input: {
    peerInstanceId: string
    toAddress: string
    envelope: AmtpEnvelope
    idempotencyKey: string
  }): Promise<OutboxEntry>

  /** Atomically claim up to `limit` entries that are due-pending OR
   *  stale-delivering (claimed longer than `staleMs` ago). Each claim CALL stamps
   *  a fresh claimToken on the entries it claims — one token per call, shared by
   *  the batch, is sufficient; per-entry tokens are also conformant. Concurrent
   *  claimers MUST never return the same entry (e.g. FOR UPDATE SKIP LOCKED in a
   *  SQL-backed store).
   *  Returned entries have claimToken set. SHOULD be ordered by next-attempt due
   *  time (quality-of-implementation, not asserted by any frozen test). */
  claimBatch(limit: number, staleMs: number): Promise<OutboxEntry[]>

  /** All three markers gate on claimToken (a zombie worker whose claim was
   *  stale-reclaimed MUST NOT clobber the new owner) and return true iff the row
   *  was actually updated. The returned boolean exists for the token-gate
   *  contract and host observability; the ENGINE never consults it (§5.10) —
   *  the reference drain awaits and discards these results. */
  markDelivered(id: string, claimToken: string): Promise<boolean>
  /** Return the entry to pending, increment attempts atomically, record `error`,
   *  and schedule the next attempt. The STORE owns backoff arithmetic (reference
   *  formula in §3.3, SHOULD-level per AMTP.md §9.3); the engine owns only the
   *  retry-vs-dead-letter decision. */
  markRetry(id: string, claimToken: string, error: string): Promise<boolean>
  /** Terminal failure ('failed'/dead-letter state), record `error`. */
  markFailedTerminal(id: string, claimToken: string, error: string): Promise<boolean>

  /** Default-deny serve check (§10.2): true iff an outbox entry destined for
   *  `peerInstanceId` references `attachmentId` in its envelope's attachments.
   *  Any status counts (queued or already sent). */
  hasOutboundAttachmentForPeer(peerInstanceId: string, attachmentId: string): Promise<boolean>
}

// ---------------------------------------------------------------------------
// §4.7 AttachmentStore
// ---------------------------------------------------------------------------

export interface AttachmentStore {
  /** Receiver-side quota accounting: total bytes currently stored. Called
   *  before any pull. */
  totalStoredBytes(): Promise<number>

  /** Sender-side serve read: blob + metadata for a locally stored attachment id.
   *  Return null for: unknown id, or blob missing/unreadable on disk — the engine
   *  maps every null to the same uniform not-found.
   *  MUST NOT throw for missing data (map read errors to null). `byteSize` is the
   *  recorded metadata value (used for content-length), not bytes.length. */
  readOutboundBlob(attachmentId: string): Promise<{
    bytes: Uint8Array
    contentType: string
    byteSize: number
  } | null>
}

// ---------------------------------------------------------------------------
// §4.8 HandleDirectory
// ---------------------------------------------------------------------------

/** Discovery listing item (§11): handle + optional UNSIGNED display hints
 *  derived from the handle's published card. */
export interface HandleListing {
  handle: string
  name?: string
  description?: string
}

export interface HandleDirectory {
  /** Resolve a LOCAL handle to a registered recipient. null when unregistered.
   *  `recipientRef` is an opaque host token (e.g. an agent UUID, or in the
   *  bundled node host the handle itself) that the engine passes through to
   *  policy + delivery untouched.
   *  `agentPublicKeyPem` is the published identity key (may be null). */
  resolve(handle: string): Promise<{
    recipientRef: string
    inboundOpen: boolean
    agentPublicKeyPem: string | null
  } | null>
  /** All published handles, sorted, for §11 discovery serve. */
  list(): Promise<HandleListing[]>
  /** The handle's published signed card (§4.6), verbatim, or null. Hosts MUST
   *  return exactly what the agent published — never re-sign or normalize. */
  getCard(handle: string): Promise<AmtpSignedAgentCard | null>
}

// ---------------------------------------------------------------------------
// §4.9 ReceivePolicy
// ---------------------------------------------------------------------------

export interface ReceivePolicy {
  /** Host-specific allow-rule check for a CLOSED mailbox. Called only when the
   *  recipient resolved, the peer is known, and inboundOpen is false — the
   *  engine owns the normative structure of §8 step 6
   *  (registered AND peer-known AND (open OR this hook)). The reference hosts
   *  match allow rules (rule peer = sender peer AND (kind 'any' OR kind 'handle'
   *  with value = senderHandle)); other hosts may implement richer policy. Default deny:
   *  return false when nothing matches. MUST NOT throw for "no". */
  isReceiveAllowed(args: { recipientRef: string; peerInstanceId: string; senderHandle: string }): Promise<boolean>

  /** Receiver attachment caps (§10.3 — receiver policy, not protocol constants).
   *  Read per-receive so runtime settings changes apply immediately (hosts
   *  SHOULD read their settings store on every request). */
  getReceiveCaps(): Promise<ReceiveCaps>
}

// ---------------------------------------------------------------------------
// §4.10 DeliveryHooks
// ---------------------------------------------------------------------------

export interface DeliveryHooks {
  /** §8 step 10 — persist the accepted message for the recipient. Called exactly
   *  once per accepted envelope, AFTER the dedup claim and AFTER all attachment
   *  blobs pulled + verified. `attachments` is [] for text-only envelopes.
   *
   *  Contract:
   *  - Resolving = the message AND all blobs are durably persisted. Anything
   *    after persistence (waking/pushing to a live agent session) is best-effort
   *    and MUST be swallowed inside the hook — it must not throw once state is
   *    durable (AMTP.md §8 step 10; wrap any post-persistence wake in its own
   *    try).
   *  - Throwing = NOTHING host-visible persisted. The hook MUST roll back its own
   *    partial state (rows, blobs) before the throw escapes. The engine then
   *    releases the dedup slot and maps
   *    the error per §4.4 (attachment envelopes) or to 502 'Delivery failed'
   *    (text envelopes).
   *  - All host-specific presentation (senderType 'remote', metadata.remote shape,
   *    metadata.sender.name, deliveryMode, reply threading) lives INSIDE this
   *    hook — see the field ledger in §7.3. */
  onMessageReceived(args: {
    envelope: AmtpEnvelope
    peerInstanceId: string
    senderHandle: string
    recipientRef: string
    agentSigVerified: boolean
    attachments: Array<{ ref: AmtpAttachmentRef; bytes: Uint8Array }>
  }): Promise<void>

  /** §9.4 — dead-letter bounce to the LOCAL authoring agent. Called after
   *  markFailedTerminal RESOLVES — the engine does NOT consult its boolean (nor
   *  any marker boolean): the bounce fires and counters increment regardless,
   *  preserving today's at-least-once bounce semantics (outbox-delivery.ts:41-42
   *  awaits and ignores the result; a stale-reclaim race can therefore
   *  double-bounce — accepted, unchanged). Best-effort: the engine catches and
   *  logs any throw; a bounce failure never un-marks the terminal state or
   *  aborts the drain (outbox-delivery.ts:40-70). Loop-safety is the
   *  implementation's obligation: the bounce MUST be a purely local message
   *  (never re-enter the outbox). `attempts` counts the failing attempt
   *  (row.attempts + 1, outbox-delivery.ts:57); NOTE it can EXCEED maxAttempts —
   *  peer-not-active requeues increment the stored counter without a delivery
   *  POST (§5.10), so a row whose peer was long inactive can dead-letter with
   *  attempts > 16. Documented, not "fixed". `senderHandle` is null when
   *  envelope.from does not parse. */
  onDeliveryFailed(args: {
    outboxId: string
    envelopeId: string
    toAddress: string
    fromAddress: string
    senderHandle: string | null
    subject?: string
    reason: string
    attempts: number
  }): Promise<void>
}
