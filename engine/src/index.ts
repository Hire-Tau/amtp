// Public engine surface (§1, §2, §5).

export type {
  AttachmentStore,
  DeliveryHooks,
  HandleDirectory,
  HandleListing,
  InstanceIdentityPort,
  OutboxEntry,
  OutboxStore,
  PeerStore,
  PinStore,
  ReceiveCaps,
  ReceivePolicy,
  ReplayLedger,
  SigningIdentity,
} from './ports'

export type {
  DrainOutboxResult,
  EnqueueSendResult,
  FetchPeerAgentCardResult,
  FetchPeerHandlesResult,
  PeerAuthResult,
  ReceiveRejectReason,
  ReceiveResult,
  ReceiveRetryReason,
  ServeAgentCardResult,
  ServeAgentKeyResult,
  ServeAttachmentResult,
} from './results'

export type { AmtpEngineOptions, AmtpEnginePorts } from './options'
export {
  ATTACHMENT_DELIVERY_TIMEOUT_MS,
  CARD_FETCH_TIMEOUT_MS,
  DELIVERY_TIMEOUT_MS,
  HANDLES_FETCH_TIMEOUT_MS,
  KEY_FETCH_TIMEOUT_MS,
  OUTBOX_CLAIM_STALE_MS,
  OUTBOX_DEFAULT_BATCH_SIZE,
  OUTBOX_MAX_ATTEMPTS,
  PULL_TIMEOUT_MS,
} from './options'

export { matchesAllowRule } from './allow-rule'

export type { VerifyInboxPostArgs, VerifySignedGetArgs } from './verify'
export type { EnqueueSendArgs } from './outbox'

export { createAmtpEngine } from './engine'
export type { AmtpEngine } from './engine'

// Default network-op implementations (§4.4, §5.8): exported so hosts can use
// the exact engine code standalone — host-kept attachment-pull / peer-key-fetch
// modules can delegate to these (§7.4) when frozen route-level suites import
// those modules directly.
export { createDefaultAttachmentPull } from './attachment-pull'
export { defaultFetchPeerAgentCard } from './peer-card-fetch'
export { defaultFetchPeerAgentKey } from './peer-key-fetch'
export type { PeerAgentKey } from './peer-key-fetch'

// Testing support surfaces for hosts (§4.12): the runner-agnostic
// conformance-suite kit, and the in-memory port fakes this package's own
// tests use. Namespaced (rather than flattened into the exports above) since
// they're a host-testing surface, not part of the engine's runtime API.
export * as contractKit from './contract-kit'
export * as testing from './testing/fakes'
