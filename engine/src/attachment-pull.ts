import {
  AMTP_HEADER_INSTANCE,
  AMTP_HEADER_SIGNATURE,
  AMTP_HEADER_TIMESTAMP,
  canonicalPeerGetString,
  signEnvelope,
} from 'amtp-protocol'
import type { AmtpAttachmentRef } from 'amtp-protocol'
import { PULL_TIMEOUT_MS } from './options'
import type { ReceiveCaps, SigningIdentity } from './ports'
import { sha256Hex } from './sha256'

// ---------------------------------------------------------------------------
// §4.4 — default attachment-pull implementation (createDefaultAttachmentPull)
// ---------------------------------------------------------------------------

/**
 * Factory for the engine's default `pullAttachment` implementation — a
 * byte-level port of the original host implementation. Exported so hosts can
 * use the exact engine code standalone (host-kept pull modules can delegate to
 * it, §7.4).
 *
 * `getCaps` is called on EVERY invocation of the returned function (not
 * cached here) — the engine's internal receive pipeline binds it to a
 * once-per-receive snapshot (§5.4 step 9.2), whereas a standalone
 * instantiation (a host delegate) supplies a `getCaps` that reads settings
 * per call, preserving a per-pull settings read.
 *
 * `fetch` is LATE-BOUND per §2: resolved from `globalThis.fetch` at call time
 * when not supplied.
 */
export function createDefaultAttachmentPull(deps: {
  signing: () => Promise<SigningIdentity>
  getCaps: () => Promise<ReceiveCaps>
  fetch?: typeof globalThis.fetch
  now?: () => number
}): (args: { peerBaseUrl: string; ref: AmtpAttachmentRef }) => Promise<Uint8Array> {
  return async ({ peerBaseUrl, ref }) => {
    // Step 1: per-item cap check, BEFORE any network call. Guard
    // Number.isFinite so a non-numeric cap never silently disables it.
    const caps = await deps.getCaps()
    if (Number.isFinite(caps.maxAttachmentBytes) && ref.byteSize > caps.maxAttachmentBytes) {
      throw new Error('ATTACHMENT_TOO_LARGE')
    }

    // Step 2: URL — raw interpolation, no encodeURIComponent (mirrors
    // attachment-pull.ts:38-39). Strip a trailing slash from peerBaseUrl.
    const base = peerBaseUrl.replace(/\/$/, '')
    const url = `${base}/amtp/attachments/${ref.id}`

    // Step 3: signed GET over the exact pathname the serving side verifies.
    const { instanceId, privateKeyPem } = await deps.signing()
    const now = deps.now ?? Date.now
    const ts = now()
    const canonical = canonicalPeerGetString('GET', new URL(url).pathname, ts)
    const signature = signEnvelope(privateKeyPem, new TextEncoder().encode(canonical))

    const fetchImpl = deps.fetch ?? globalThis.fetch
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: {
        [AMTP_HEADER_INSTANCE]: instanceId,
        [AMTP_HEADER_SIGNATURE]: signature,
        [AMTP_HEADER_TIMESTAMP]: String(ts),
      },
      signal: AbortSignal.timeout(PULL_TIMEOUT_MS),
    })

    // Step 4: non-2xx → ATTACHMENT_PULL_FAILED; a network/timeout throw
    // propagates raw (classified "anything else" → 502 by the caller).
    if (res.status < 200 || res.status >= 300) {
      throw new Error('ATTACHMENT_PULL_FAILED')
    }

    const buffer = await res.arrayBuffer()
    const bytes = new Uint8Array(buffer)

    // Step 5: size then hash verification.
    if (bytes.length !== ref.byteSize) {
      throw new Error('ATTACHMENT_SIZE_MISMATCH')
    }
    if (sha256Hex(bytes) !== ref.sha256) {
      throw new Error('ATTACHMENT_HASH_MISMATCH')
    }

    return bytes
  }
}
