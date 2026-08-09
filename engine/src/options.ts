import type { AmtpAttachmentRef } from 'amtp-protocol'
import type {
  AttachmentStore,
  DeliveryHooks,
  HandleDirectory,
  InstanceIdentityPort,
  OutboxStore,
  PeerStore,
  PinStore,
  ReceivePolicy,
  ReplayLedger,
} from './ports'

// ---------------------------------------------------------------------------
// §2 — engine construction
// ---------------------------------------------------------------------------

export interface AmtpEnginePorts {
  identity: InstanceIdentityPort
  peers: PeerStore
  pins: PinStore
  replays: ReplayLedger
  outbox: OutboxStore
  attachments: AttachmentStore
  handles: HandleDirectory
  policy: ReceivePolicy
  delivery: DeliveryHooks
}

export interface AmtpEngineOptions {
  /** default: LATE-BOUND globalThis.fetch — every network operation MUST
   *  resolve `globalThis.fetch` AT CALL TIME (`(opts.fetch ?? globalThis.fetch)(…)`
   *  per request), never capture it at construction or module load. Frozen host
   *  suites stub `globalThis.fetch` after module load and restore it in
   *  `afterEach`; an early-captured reference would bypass the stub and break
   *  such suites. */
  fetch?: typeof globalThis.fetch
  /** default: Date.now */
  now?: () => number
  /** default: crypto.randomUUID */
  uuid?: () => string
  /** default: no-op */
  logger?: (level: 'info' | 'warn', message: string) => void
  /** High-level network-op seams. Defaults are the engine's internal
   *  implementations (which use `fetch`). Exist so host route-level test seams
   *  (__setPullImpl / __setKeyFetchImpl) keep working unchanged — see §7.1. */
  overrides?: {
    fetchPeerAgentKey?: (args: {
      peerBaseUrl: string
      handle: string
    }) => Promise<{ handle: string; instanceId: string; identityPublicKey: string }>
    fetchPeerAgentCard?: (args: { peerBaseUrl: string; handle: string }) => Promise<unknown>
    pullAttachment?: (args: {
      peerBaseUrl: string
      legacySignedGetPathPrefix?: string
      ref: AmtpAttachmentRef
    }) => Promise<Uint8Array>
  }
  outbox?: {
    batchSize?: number // default OUTBOX_DEFAULT_BATCH_SIZE (outbox-delivery.ts:13)
    maxAttempts?: number // default OUTBOX_MAX_ATTEMPTS (entities/Outbox.ts:18)
    claimStaleMs?: number // default OUTBOX_CLAIM_STALE_MS (entities/Outbox.ts:11)
    deliveryTimeoutMs?: number // default DELIVERY_TIMEOUT_MS (outbox-delivery.ts:133)
    attachmentDeliveryTimeoutMs?: number // default ATTACHMENT_DELIVERY_TIMEOUT_MS (outbox-delivery.ts:132)
  }
}

// ---------------------------------------------------------------------------
// §3.3 — engine constants
// ---------------------------------------------------------------------------
// Values are frozen: they must stay equal to the reference implementation's
// original constants (outbox retry/backoff, attachment pull, peer key/handles
// fetch timeouts).

export const OUTBOX_MAX_ATTEMPTS = 16
export const OUTBOX_CLAIM_STALE_MS = 300_000
export const OUTBOX_DEFAULT_BATCH_SIZE = 20
export const DELIVERY_TIMEOUT_MS = 10_000
export const ATTACHMENT_DELIVERY_TIMEOUT_MS = 60_000
export const PULL_TIMEOUT_MS = 10_000
export const KEY_FETCH_TIMEOUT_MS = 10_000
export const HANDLES_FETCH_TIMEOUT_MS = 10_000
export const CARD_FETCH_TIMEOUT_MS = 10_000
