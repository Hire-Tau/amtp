import type { AmtpAgentCard, AmtpSignedAgentCard } from 'amtp-protocol'
import type { HandleListing, OutboxEntry } from './ports'

// ---------------------------------------------------------------------------
// §5.2 / §5.3 — transport auth
// ---------------------------------------------------------------------------

export type PeerAuthResult = { ok: true; peerInstanceId: string } | { ok: false }

// ---------------------------------------------------------------------------
// §5.4 — receiveEnvelope
// ---------------------------------------------------------------------------

export type ReceiveRejectReason =
  | 'invalid_envelope'
  | 'stale_timestamp'
  | 'from_mismatch'
  | 'invalid_recipient_address'
  | 'recipient_not_found'
  | 'not_allowed'
  | 'pin_mismatch'
  | 'attachment_too_large'
  | 'attachment_verification_failed'

export type ReceiveRetryReason = 'key_unavailable' | 'quota_exceeded' | 'pull_failed' | 'delivery_failed'

export type ReceiveResult =
  | { kind: 'accepted'; httpStatus: 200; body: { accepted: true; duplicate?: true } }
  | {
      kind: 'rejected'
      httpStatus: 400 | 403 | 404 | 413 | 422
      reason: ReceiveRejectReason
      body: { error: string }
    }
  | { kind: 'retryable'; httpStatus: 502 | 507; reason: ReceiveRetryReason; body: { error: string } }

// ---------------------------------------------------------------------------
// §5.5 — serveAttachment
// ---------------------------------------------------------------------------

export type ServeAttachmentResult =
  | { found: true; bytes: Uint8Array; contentType: string; byteSize: number }
  | { found: false }

// ---------------------------------------------------------------------------
// §5.7 — serveAgentKey
// ---------------------------------------------------------------------------

export type ServeAgentKeyResult =
  | { found: true; handle: string; instanceId: string; identityPublicKey: string }
  | { found: false }

// ---------------------------------------------------------------------------
// §4.6 — serveAgentCard
// ---------------------------------------------------------------------------

export type ServeAgentCardResult = { found: true; signedCard: AmtpSignedAgentCard } | { found: false }

// ---------------------------------------------------------------------------
// §5.8 — fetchPeerHandles
// ---------------------------------------------------------------------------

export type FetchPeerHandlesResult = { ok: true; handles: HandleListing[] } | { ok: false }

// ---------------------------------------------------------------------------
// §4.6 — fetchPeerAgentCard (client-side verified fetch)
// ---------------------------------------------------------------------------

export type FetchPeerAgentCardResult =
  | { ok: true; card: AmtpAgentCard; signedCard: AmtpSignedAgentCard }
  | { ok: false }

// ---------------------------------------------------------------------------
// §5.9 — enqueueSend
// ---------------------------------------------------------------------------

export type EnqueueSendResult = { ok: true; entry: OutboxEntry } | { ok: false; reason: 'invalid_address' }

// ---------------------------------------------------------------------------
// §5.10 — drainOutboxOnce
// ---------------------------------------------------------------------------

export type DrainOutboxResult = { delivered: number; failedTerminal: number; retried: number }
