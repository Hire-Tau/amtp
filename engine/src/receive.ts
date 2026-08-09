import {
  amtpEnvelopeSchema,
  canonicalAgentSigBytes,
  ENVELOPE_FRESHNESS_MS,
  parseAmtpAddress,
  verifyEnvelope,
} from 'amtp-protocol'
import type { AmtpAttachmentRef, AmtpEnvelope } from 'amtp-protocol'
import { createDefaultAttachmentPull } from './attachment-pull'
import type { AmtpEngineOptions, AmtpEnginePorts } from './options'
import { defaultFetchPeerAgentKey } from './peer-key-fetch'
import type { ReceiveRejectReason, ReceiveResult, ReceiveRetryReason } from './results'

// ---------------------------------------------------------------------------
// §5.4 receiveEnvelope — the §8 pipeline
// ---------------------------------------------------------------------------

/** The runtime injectables receiveEnvelope needs, threaded in by engine.ts. */
export interface ReceiveEnvelopeRuntime {
  now: () => number
  /** Late-bound per §2 — resolved by the network-op call sites, not here. */
  fetch?: typeof globalThis.fetch
  overrides?: AmtpEngineOptions['overrides']
}

function rejected(httpStatus: 400 | 403 | 404 | 413 | 422, reason: ReceiveRejectReason, error: string): ReceiveResult {
  return { kind: 'rejected', httpStatus, reason, body: { error } }
}

function retryable(httpStatus: 502 | 507, reason: ReceiveRetryReason, error: string): ReceiveResult {
  return { kind: 'retryable', httpStatus, reason, body: { error } }
}

const ACCEPTED: ReceiveResult = { kind: 'accepted', httpStatus: 200, body: { accepted: true } }
const ACCEPTED_DUPLICATE: ReceiveResult = {
  kind: 'accepted',
  httpStatus: 200,
  body: { accepted: true, duplicate: true },
}

/**
 * §4.4 — classify a thrown attachment-phase `Error.message` against the fixed
 * code table. `fallbackReason` distinguishes the "anything else" case between
 * the pull step (9.1–9.3, `pull_failed`) and the delivery-hook call (9.4,
 * `delivery_failed`) — both share the SAME body text 'Attachment pull failed'
 * (the deliberate catch-all quirk, routes/amtp.ts:557-563), but the engine's
 * `reason` tag differs by which step actually threw.
 */
function classifyAttachmentError(err: unknown, fallbackReason: 'pull_failed' | 'delivery_failed'): ReceiveResult {
  const msg = err instanceof Error ? err.message : String(err)
  if (msg === 'ATTACHMENT_TOO_LARGE') return rejected(413, 'attachment_too_large', 'Attachment too large')
  if (msg === 'ATTACHMENT_HASH_MISMATCH' || msg === 'ATTACHMENT_SIZE_MISMATCH') {
    return rejected(422, 'attachment_verification_failed', 'Attachment verification failed')
  }
  if (msg === 'INBOX_STORAGE_QUOTA_EXCEEDED') return retryable(507, 'quota_exceeded', 'Inbox storage quota exceeded')
  return retryable(502, fallbackReason, 'Attachment pull failed')
}

async function receiveWithAttachments(
  ports: AmtpEnginePorts,
  runtime: ReceiveEnvelopeRuntime,
  ctx: {
    peerInstanceId: string
    env: AmtpEnvelope
    attachments: AmtpAttachmentRef[]
    senderHandle: string
    recipientRef: string
    agentSigVerified: boolean
  }
): Promise<ReceiveResult> {
  const { peerInstanceId, env, attachments, senderHandle, recipientRef, agentSigVerified } = ctx
  let deliveryPhase = false

  try {
    // 9.1: resolve peer for its baseUrl (needed to pull blobs).
    const peer = await ports.peers.getPeer(peerInstanceId)
    if (!peer) throw new Error('ATTACHMENT_PULL_FAILED')

    // 9.2: ONE receive-caps snapshot, used for the aggregate quota check AND
    // threaded to the per-item pull checks below.
    const caps = await ports.policy.getReceiveCaps()
    const incoming = attachments.reduce((sum, r) => sum + r.byteSize, 0)
    const existing = await ports.attachments.totalStoredBytes()
    // No Number.isFinite guard: `existing + incoming > cap` is already false
    // for a non-finite cap (Infinity or NaN), exactly routes/amtp.ts:506-509.
    if (existing + incoming > caps.maxTotalStorageBytes) {
      throw new Error('INBOX_STORAGE_QUOTA_EXCEEDED')
    }

    // 9.3: pull each blob, in envelope order, sequentially.
    const pull =
      runtime.overrides?.pullAttachment ??
      createDefaultAttachmentPull({
        signing: () => ports.identity.getSigning(),
        getCaps: async () => caps,
        fetch: runtime.fetch,
        now: runtime.now,
      })
    const pulled: Array<{ ref: AmtpAttachmentRef; bytes: Uint8Array }> = []
    for (const ref of attachments) {
      const bytes = await pull({ peerBaseUrl: peer.baseUrl, legacySignedGetPathPrefix: peer.legacySignedGetPathPrefix, ref })
      pulled.push({ ref, bytes })
    }

    // 9.4: all pulled — deliver.
    deliveryPhase = true
    await ports.delivery.onMessageReceived({
      envelope: env,
      peerInstanceId,
      senderHandle,
      recipientRef,
      agentSigVerified,
      attachments: pulled,
    })
  } catch (err) {
    await ports.replays.unrecord(peerInstanceId, env.id)
    return classifyAttachmentError(err, deliveryPhase ? 'delivery_failed' : 'pull_failed')
  }

  return ACCEPTED
}

/**
 * §5.4 — the §8 receive pipeline. `args.peerInstanceId` is the verified
 * output of `verifyInboxPost` (transport auth is a host precondition, done
 * before this is called — step 1). Steps 2–7 all return before the step-8
 * dedup claim; step 9 (attachments) / step 10 (text) follow.
 */
export async function receiveEnvelope(
  ports: AmtpEnginePorts,
  runtime: ReceiveEnvelopeRuntime,
  args: { peerInstanceId: string; rawBody: string }
): Promise<ReceiveResult> {
  const { peerInstanceId, rawBody } = args

  // Step 2: parse + validate.
  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody)
  } catch {
    return rejected(400, 'invalid_envelope', 'Invalid envelope')
  }
  const parseResult = amtpEnvelopeSchema.safeParse(parsed)
  if (!parseResult.success) {
    return rejected(400, 'invalid_envelope', 'Invalid envelope')
  }
  const env = parseResult.data as AmtpEnvelope

  // Step 3: freshness (strict).
  if (Math.abs(runtime.now() - env.ts) > ENVELOPE_FRESHNESS_MS) {
    return rejected(400, 'stale_timestamp', 'Envelope timestamp out of range')
  }

  // Step 4: from-integrity.
  const fromAddr = parseAmtpAddress(env.from)
  if (!fromAddr || fromAddr.instanceId !== peerInstanceId) {
    return rejected(400, 'from_mismatch', 'Envelope from-instance does not match verified peer')
  }
  const senderHandle = fromAddr.handle

  // Step 5: recipient resolution.
  const to = parseAmtpAddress(env.to)
  if (!to) {
    return rejected(400, 'invalid_recipient_address', 'Invalid recipient address')
  }
  const identity = await ports.identity.get()
  if (to.instanceId !== identity.instanceId) {
    return rejected(404, 'recipient_not_found', 'Recipient not found')
  }
  const resolved = await ports.handles.resolve(to.handle)
  if (!resolved) {
    return rejected(404, 'recipient_not_found', 'Recipient not found')
  }

  // Step 6: policy gate (default-deny).
  const gatePeer = await ports.peers.getPeer(peerInstanceId)
  if (!gatePeer) {
    return rejected(403, 'not_allowed', 'Sender not allowed')
  }
  if (!resolved.inboundOpen) {
    const allowed = await ports.policy.isReceiveAllowed({
      recipientRef: resolved.recipientRef,
      peerInstanceId,
      senderHandle,
    })
    if (!allowed) {
      return rejected(403, 'not_allowed', 'Sender not allowed')
    }
  }

  // Step 7: agent authorship — only when env.agentKey is present.
  let agentSigVerified = false
  if (env.agentKey) {
    let pinned = await ports.pins.getPin(peerInstanceId, senderHandle)
    if (!pinned) {
      const peer = await ports.peers.getPeer(peerInstanceId)
      if (!peer) {
        return rejected(403, 'not_allowed', 'Sender not allowed')
      }
      const fetchKey =
        runtime.overrides?.fetchPeerAgentKey ?? ((a) => defaultFetchPeerAgentKey({ ...a, fetchImpl: runtime.fetch }))
      try {
        const fetched = await fetchKey({ peerBaseUrl: peer.baseUrl, handle: senderHandle })
        pinned = await ports.pins.recordPinIfNew(peerInstanceId, senderHandle, fetched.identityPublicKey)
      } catch {
        // Fail CLOSED, BEFORE the dedup claim (routes/amtp.ts:420-430).
        return retryable(502, 'key_unavailable', 'Sender key unavailable; retry later')
      }
    }
    if (env.agentKey !== pinned) {
      return rejected(403, 'pin_mismatch', 'Sender key mismatch')
    }
    if (env.agentSig) {
      const sigBytes = canonicalAgentSigBytes({
        v: 1,
        id: env.id,
        from: env.from,
        to: env.to,
        subject: env.subject,
        content: env.content,
        attachments: (env.attachments ?? []).map((a) => ({
          filename: a.filename,
          contentType: a.contentType,
          byteSize: a.byteSize,
          sha256: a.sha256,
        })),
      })
      // Advisory only — never a rejection.
      agentSigVerified = verifyEnvelope(pinned, sigBytes, env.agentSig)
    }
  }

  // Step 8: replay dedup — claimed only after every check above.
  const isNew = await ports.replays.recordIfNew(peerInstanceId, env.id)
  if (!isNew) {
    return ACCEPTED_DUPLICATE
  }

  // Step 9 / 10: attachment or text delivery.
  if (env.attachments?.length) {
    return receiveWithAttachments(ports, runtime, {
      peerInstanceId,
      env,
      attachments: env.attachments,
      senderHandle,
      recipientRef: resolved.recipientRef,
      agentSigVerified,
    })
  }

  try {
    await ports.delivery.onMessageReceived({
      envelope: env,
      peerInstanceId,
      senderHandle,
      recipientRef: resolved.recipientRef,
      agentSigVerified,
      attachments: [],
    })
  } catch {
    await ports.replays.unrecord(peerInstanceId, env.id)
    return retryable(502, 'delivery_failed', 'Delivery failed')
  }

  return ACCEPTED
}
