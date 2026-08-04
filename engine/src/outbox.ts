import {
  AMTP_HEADER_INSTANCE,
  AMTP_HEADER_SIGNATURE,
  formatAmtpAddress,
  isRetryableHttpStatus,
  parseAmtpAddress,
  signEnvelope,
} from 'amtp-protocol'
import type { AmtpEnvelope } from 'amtp-protocol'
import type { AmtpEnginePorts } from './options'
import type { OutboxEntry } from './ports'
import type { DrainOutboxResult, EnqueueSendResult } from './results'

// ---------------------------------------------------------------------------
// §5.9 enqueueSend
// ---------------------------------------------------------------------------

export interface EnqueueSendArgs {
  fromHandle: string
  toAddress: string
  subject?: string
  content: string
  inReplyTo?: string
  attachments?: AmtpEnvelope['attachments']
  /** Pre-agreed envelope id (signed sends); default runtime.uuid(). */
  id?: string
  agentKey?: string
  agentSig?: string
}

export interface EnqueueSendRuntime {
  now: () => number
  uuid: () => string
}

/**
 * §5.9 — port of services/amtp/send.ts:12-52. The envelope is stored UNSIGNED;
 * the drain re-stamps/re-signs it (§5.10).
 */
export async function enqueueSend(
  ports: AmtpEnginePorts,
  runtime: EnqueueSendRuntime,
  args: EnqueueSendArgs
): Promise<EnqueueSendResult> {
  const to = parseAmtpAddress(args.toAddress)
  if (!to) return { ok: false, reason: 'invalid_address' }

  const identity = await ports.identity.get()
  // Coerce blank/whitespace-only subject to undefined while keeping the
  // ORIGINAL untrimmed string when non-blank (send.ts:29).
  const subject = args.subject?.trim() ? args.subject : undefined
  const id = args.id ?? runtime.uuid()

  const envelope: AmtpEnvelope = {
    v: 1,
    id,
    ts: runtime.now(),
    from: formatAmtpAddress(identity.instanceId, args.fromHandle),
    to: args.toAddress,
    subject,
    content: args.content,
    inReplyTo: args.inReplyTo,
    agentKey: args.agentKey,
    agentSig: args.agentSig,
    attachments: args.attachments && args.attachments.length > 0 ? args.attachments : undefined,
  }

  const entry = await ports.outbox.enqueue({
    peerInstanceId: to.instanceId,
    toAddress: args.toAddress,
    envelope,
    idempotencyKey: id,
  })

  return { ok: true, entry }
}

// ---------------------------------------------------------------------------
// §5.10 drainOutboxOnce — the §9 machine
// ---------------------------------------------------------------------------

export interface DrainOutboxRuntime {
  now: () => number
  /** Late-bound per §2 — resolved at the fetch call site, not here. */
  fetch?: typeof globalThis.fetch
  logger: (level: 'info' | 'warn', message: string) => void
  maxAttempts: number
  claimStaleMs: number
  deliveryTimeoutMs: number
  attachmentDeliveryTimeoutMs: number
}

/**
 * Dead-letter an outbox row: `markFailedTerminal` then `onDeliveryFailed`,
 * UNCONDITIONALLY — the engine never consults the marker's boolean result
 * (§4.6, §4.10, §5.10). A hook throw is caught + logged; it never un-marks
 * the terminal state or aborts the drain.
 */
async function deadLetter(
  ports: AmtpEnginePorts,
  logger: (level: 'info' | 'warn', message: string) => void,
  row: OutboxEntry,
  reason: string
): Promise<void> {
  await ports.outbox.markFailedTerminal(row.id, row.claimToken as string, reason)
  try {
    await ports.delivery.onDeliveryFailed({
      outboxId: row.id,
      envelopeId: row.envelope.id,
      toAddress: row.toAddress,
      fromAddress: row.envelope.from,
      senderHandle: parseAmtpAddress(row.envelope.from)?.handle ?? null,
      subject: row.envelope.subject,
      reason,
      attempts: row.attempts + 1,
    })
  } catch (err) {
    logger('warn', `Outbox row ${row.id} bounce send failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * §5.10 — port of services/amtp/outbox-delivery.ts:91-184. One independent
 * try/catch per row (a bad row never aborts the batch). The engine never
 * consults `markDelivered`/`markRetry`/`markFailedTerminal`'s boolean result
 * anywhere here — counters increment purely on the engine's own
 * classification (§4.6, §4.10).
 */
export async function drainOutboxOnce(
  ports: AmtpEnginePorts,
  runtime: DrainOutboxRuntime,
  batchSize: number
): Promise<DrainOutboxResult> {
  const rows = await ports.outbox.claimBatch(batchSize, runtime.claimStaleMs)

  // Resolve signing identity once per drain, before the row loop.
  const signing = await ports.identity.getSigning()

  let delivered = 0
  let failedTerminal = 0
  let retried = 0

  for (const row of rows) {
    try {
      const peer = await ports.peers.getPeer(row.peerInstanceId)
      if (!peer || peer.status !== 'active') {
        // Unconditional retry — this branch never dead-letters, even past
        // maxAttempts (rows for vanished/inactive peers retry forever with
        // capped backoff; preserved exactly, §5.10 quirk).
        await ports.outbox.markRetry(
          row.id,
          row.claimToken as string,
          peer ? `peer not active: ${peer.status}` : `peer not found: ${row.peerInstanceId}`
        )
        retried++
        continue
      }

      // Re-stamp ts to current time; the envelope id (replay nonce) stays
      // unchanged for receiver dedup.
      const freshEnvelope = { ...row.envelope, ts: runtime.now() }
      const body = JSON.stringify(freshEnvelope)
      const bytes = new TextEncoder().encode(body)
      const signature = signEnvelope(signing.privateKeyPem, bytes)

      const deliveryTimeoutMs = freshEnvelope.attachments?.length
        ? runtime.attachmentDeliveryTimeoutMs
        : runtime.deliveryTimeoutMs

      const baseUrl = peer.baseUrl.replace(/\/$/, '')
      const fetchImpl = runtime.fetch ?? globalThis.fetch
      const res = await fetchImpl(`${baseUrl}/amtp/inbox`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [AMTP_HEADER_INSTANCE]: signing.instanceId,
          [AMTP_HEADER_SIGNATURE]: signature,
        },
        body,
        signal: AbortSignal.timeout(deliveryTimeoutMs),
      })

      if (res.status >= 200 && res.status < 300) {
        await ports.outbox.markDelivered(row.id, row.claimToken as string)
        delivered++
      } else {
        const retryable = isRetryableHttpStatus(res.status)
        const reason = `delivery failed: HTTP ${res.status}`
        if (!retryable) {
          await deadLetter(ports, runtime.logger, row, reason)
          failedTerminal++
        } else if (row.attempts + 1 >= runtime.maxAttempts) {
          await deadLetter(ports, runtime.logger, row, `max delivery attempts exceeded: ${reason}`)
          failedTerminal++
        } else {
          await ports.outbox.markRetry(row.id, row.claimToken as string, reason)
          retried++
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      runtime.logger('warn', `Outbox row ${row.id} delivery error: ${message}`)
      if (row.attempts + 1 >= runtime.maxAttempts) {
        await deadLetter(ports, runtime.logger, row, `max delivery attempts exceeded: ${message}`)
        failedTerminal++
      } else {
        await ports.outbox.markRetry(row.id, row.claimToken as string, message)
        retried++
      }
    }
  }

  if (delivered || failedTerminal || retried) {
    runtime.logger('info', `Outbox drain: delivered=${delivered} failed=${failedTerminal} retried=${retried}`)
  }

  return { delivered, failedTerminal, retried }
}
