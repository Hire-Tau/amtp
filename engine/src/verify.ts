import { canonicalPeerGetString, PEER_GET_FRESHNESS_MS, verifyEnvelope } from 'amtp-protocol'
import type { PeerStore } from './ports'
import type { PeerAuthResult } from './results'

type Logger = (level: 'info' | 'warn', message: string) => void
const noopLogger: Logger = () => {}
function log(logger: Logger, level: 'info' | 'warn', event: Record<string, unknown>): void {
  logger(level, JSON.stringify(event))
}

// ---------------------------------------------------------------------------
// §5.2 verifyInboxPost / §5.3 verifySignedGet — transport auth
// ---------------------------------------------------------------------------

export interface VerifyInboxPostArgs {
  /** x-amtp-instance */
  instanceHeader: string | undefined
  /** x-amtp-signature */
  signatureHeader: string | undefined
  /** Exact raw request body text. */
  rawBody: string
}

export interface VerifySignedGetArgs {
  /** 'GET' */
  method: string
  /** Host-observed pathname, retained only as the 0.1 transition fallback. */
  path: string
  /** Exact AMTP route pathname selected by the host router. */
  routePath?: string
  instanceHeader: string | undefined
  signatureHeader: string | undefined
  /** x-amtp-timestamp, decimal ms. */
  timestampHeader: string | undefined
}

/**
 * §5.2 — ported from middleware/require-peer-signature.ts:28-52. Returns
 * `{ok:false}` (host maps to uniform 401) when: either header missing;
 * `peers.getPeer(instance)` is null or `status !== 'active'`; or the signature
 * fails to verify. Verification exceptions are swallowed by `verifyEnvelope`
 * itself (never a throw).
 */
export async function verifyInboxPost(peers: PeerStore, args: VerifyInboxPostArgs): Promise<PeerAuthResult> {
  const { instanceHeader, signatureHeader, rawBody } = args
  if (!instanceHeader || !signatureHeader) return { ok: false }

  const peer = await peers.getPeer(instanceHeader)
  if (!peer || peer.status !== 'active') return { ok: false }

  if (!verifyEnvelope(peer.publicKeyPem, new TextEncoder().encode(rawBody), signatureHeader)) {
    return { ok: false }
  }

  return { ok: true, peerInstanceId: instanceHeader }
}

/**
 * §5.3 — ported from middleware/require-peer-signature-get.ts:12-32. Uniform
 * `{ok:false}` (host maps to 401) when: any header missing;
 * `Number(timestampHeader)` non-finite or stale beyond `PEER_GET_FRESHNESS_MS`;
 * peer unknown/not-active; or the signature fails over
 * `canonicalPeerGetString(method, path, ts)`. The result never says which
 * check failed.
 */
export async function verifySignedGet(
  peers: PeerStore,
  args: VerifySignedGetArgs,
  now: () => number,
  logger: Logger = noopLogger
): Promise<PeerAuthResult> {
  const { method, path, routePath, instanceHeader, signatureHeader, timestampHeader } = args
  const fail = (reason: string, extra: Record<string, unknown> = {}): PeerAuthResult => {
    log(logger, 'warn', { event: 'amtp.signed_get_auth_failure', reason, ...(instanceHeader ? { instanceId: instanceHeader } : {}), ...extra })
    return { ok: false }
  }
  if (!instanceHeader || !signatureHeader || !timestampHeader) return fail('missing_headers')

  const ts = Number(timestampHeader)
  if (!Number.isFinite(ts)) return fail('invalid_timestamp')
  if (Math.abs(now() - ts) > PEER_GET_FRESHNESS_MS) return fail('stale_timestamp')

  const peer = await peers.getPeer(instanceHeader)
  if (!peer) return fail('unknown_peer')
  if (peer.status !== 'active') return fail('inactive_peer')

  const paths = [...new Set([routePath, path].filter((candidate): candidate is string => candidate !== undefined))]
  for (let index = 0; index < paths.length; index += 1) {
    const canonical = canonicalPeerGetString(method, paths[index], ts)
    if (verifyEnvelope(peer.publicKeyPem, new TextEncoder().encode(canonical), signatureHeader)) {
      if (index > 0) log(logger, 'info', { event: 'amtp.signed_get_legacy_path_accepted', mode: 'legacy_observed_path', instanceId: instanceHeader })
      return { ok: true, peerInstanceId: instanceHeader }
    }
  }
  const canonical = canonicalPeerGetString(method, paths[0], ts)
  const legacyObservedCanonical = paths.length > 1 ? canonicalPeerGetString(method, paths[1], ts) : undefined
  return fail('signature_mismatch', { canonical, ...(legacyObservedCanonical ? { legacyObservedCanonical } : {}) })
}
