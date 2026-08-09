import { randomUUID } from 'node:crypto'
import {
  ATTACHMENT_DELIVERY_TIMEOUT_MS,
  DELIVERY_TIMEOUT_MS,
  OUTBOX_CLAIM_STALE_MS,
  OUTBOX_DEFAULT_BATCH_SIZE,
  OUTBOX_MAX_ATTEMPTS,
} from './options'
import type { AmtpEngineOptions, AmtpEnginePorts } from './options'
import { fetchPeerAgentCard, fetchPeerHandles, listHandles, serveAgentCard, serveAgentKey } from './discovery'
import { drainOutboxOnce, enqueueSend } from './outbox'
import type { EnqueueSendArgs } from './outbox'
import type { HandleListing } from './ports'
import { receiveEnvelope } from './receive'
import type {
  DrainOutboxResult,
  EnqueueSendResult,
  FetchPeerAgentCardResult,
  FetchPeerHandlesResult,
  PeerAuthResult,
  ReceiveResult,
  ServeAgentCardResult,
  ServeAgentKeyResult,
  ServeAttachmentResult,
} from './results'
import { serveAttachment } from './serve'
import { verifyInboxPost, verifySignedGet } from './verify'
import type { VerifyInboxPostArgs, VerifySignedGetArgs } from './verify'

// ---------------------------------------------------------------------------
// §2 / §5 — engine construction and public API (the full 10-method surface)
// ---------------------------------------------------------------------------

export interface AmtpEngine {
  getIdentity(): Promise<{ instanceId: string; publicKeyPem: string }>
  verifyInboxPost(args: VerifyInboxPostArgs): Promise<PeerAuthResult>
  verifySignedGet(args: VerifySignedGetArgs): Promise<PeerAuthResult>
  receiveEnvelope(args: { peerInstanceId: string; rawBody: string }): Promise<ReceiveResult>
  serveAttachment(args: { peerInstanceId: string; attachmentId: string }): Promise<ServeAttachmentResult>
  listHandles(): Promise<{ handles: HandleListing[] }>
  serveAgentKey(handle: string): Promise<ServeAgentKeyResult>
  serveAgentCard(handle: string): Promise<ServeAgentCardResult>
  fetchPeerHandles(args: {
    peerBaseUrl: string
    legacySignedGetPathPrefix?: string
  }): Promise<FetchPeerHandlesResult>
  fetchPeerAgentCard(args: { peerInstanceId: string; handle: string }): Promise<FetchPeerAgentCardResult>
  enqueueSend(args: EnqueueSendArgs): Promise<EnqueueSendResult>
  drainOutboxOnce(opts?: { batchSize?: number }): Promise<DrainOutboxResult>
}

/**
 * Construction is cheap and side-effect-free (no port calls) per §2. Hosts
 * may build one singleton or a fresh engine per operation.
 */
export function createAmtpEngine(ports: AmtpEnginePorts, opts: AmtpEngineOptions = {}): AmtpEngine {
  const now = opts.now ?? Date.now
  const uuid = opts.uuid ?? randomUUID
  const logger = opts.logger ?? (() => {})

  const outboxOpts = opts.outbox ?? {}
  const maxAttempts = outboxOpts.maxAttempts ?? OUTBOX_MAX_ATTEMPTS
  const claimStaleMs = outboxOpts.claimStaleMs ?? OUTBOX_CLAIM_STALE_MS
  const deliveryTimeoutMs = outboxOpts.deliveryTimeoutMs ?? DELIVERY_TIMEOUT_MS
  const attachmentDeliveryTimeoutMs = outboxOpts.attachmentDeliveryTimeoutMs ?? ATTACHMENT_DELIVERY_TIMEOUT_MS
  const defaultBatchSize = outboxOpts.batchSize ?? OUTBOX_DEFAULT_BATCH_SIZE

  return {
    async getIdentity() {
      const { instanceId, publicKeyPem } = await ports.identity.get()
      return { instanceId, publicKeyPem }
    },
    verifyInboxPost(args) {
      return verifyInboxPost(ports.peers, args)
    },
    verifySignedGet(args) {
      return verifySignedGet(ports.peers, args, now)
    },
    receiveEnvelope(args) {
      return receiveEnvelope(ports, { now, fetch: opts.fetch, overrides: opts.overrides }, args)
    },
    serveAttachment(args) {
      return serveAttachment(ports, args)
    },
    listHandles() {
      return listHandles(ports)
    },
    serveAgentKey(handle) {
      return serveAgentKey(ports, handle)
    },
    serveAgentCard(handle) {
      return serveAgentCard(ports, handle)
    },
    fetchPeerHandles(args) {
      return fetchPeerHandles(ports, { now, fetch: opts.fetch }, args)
    },
    fetchPeerAgentCard(args) {
      return fetchPeerAgentCard(ports, { now, fetch: opts.fetch, overrides: opts.overrides }, args)
    },
    enqueueSend(args) {
      return enqueueSend(ports, { now, uuid }, args)
    },
    drainOutboxOnce(callOpts) {
      return drainOutboxOnce(
        ports,
        { now, fetch: opts.fetch, logger, maxAttempts, claimStaleMs, deliveryTimeoutMs, attachmentDeliveryTimeoutMs },
        callOpts?.batchSize ?? defaultBatchSize
      )
    },
  }
}
