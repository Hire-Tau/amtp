import { canonicalPeerGetString, PEER_GET_FRESHNESS_MS, verifyEnvelope } from 'amtp-protocol'
import type { PeerStore } from './ports'
import type { PeerAuthResult } from './results'

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
  /** FULL observed pathname incl. mount prefix. */
  path: string
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
  now: () => number
): Promise<PeerAuthResult> {
  const { method, path, instanceHeader, signatureHeader, timestampHeader } = args
  if (!instanceHeader || !signatureHeader || !timestampHeader) return { ok: false }

  const ts = Number(timestampHeader)
  if (!Number.isFinite(ts) || Math.abs(now() - ts) > PEER_GET_FRESHNESS_MS) return { ok: false }

  const peer = await peers.getPeer(instanceHeader)
  if (!peer || peer.status !== 'active') return { ok: false }

  const bytes = new TextEncoder().encode(canonicalPeerGetString(method, path, ts))
  if (!verifyEnvelope(peer.publicKeyPem, bytes, signatureHeader)) return { ok: false }

  return { ok: true, peerInstanceId: instanceHeader }
}
