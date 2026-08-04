/** HTTP header carrying the sender's self-certifying instance id. */
export const AMTP_HEADER_INSTANCE = 'x-amtp-instance'

/** HTTP header carrying the detached Ed25519 signature (base64). */
export const AMTP_HEADER_SIGNATURE = 'x-amtp-signature'

/** HTTP header carrying the epoch-ms timestamp signed for a bodyless GET. */
export const AMTP_HEADER_TIMESTAMP = 'x-amtp-timestamp'

/** Envelope `ts` freshness window (±5 min) enforced by the receiver. */
export const ENVELOPE_FRESHNESS_MS = 300000

/** HTTP status codes that warrant a retry rather than a terminal failure. */
export const RETRYABLE_HTTP_STATUS = [408, 429]

/** Whether an HTTP status warrants an outbox retry rather than dead-lettering. */
export function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500
}
