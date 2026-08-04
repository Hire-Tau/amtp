import { KEY_FETCH_TIMEOUT_MS } from './options'

// ---------------------------------------------------------------------------
// §5.8 — default fetchPeerAgentKey implementation
// ---------------------------------------------------------------------------

export interface PeerAgentKey {
  handle: string
  instanceId: string
  identityPublicKey: string
}

/**
 * A straight port of services/amtp/peer-key-fetch.ts:12-39. Public GET
 * `<base>/amtp/agents/<encodeURIComponent(handle)>/key`, `KEY_FETCH_TIMEOUT_MS`
 * timeout; throws `PEER_KEY_FETCH_FAILED` on network failure, non-2xx, or a
 * body without a non-empty string `identityPublicKey`; tolerates missing
 * `handle`/`instanceId` in the body (falls back to the request handle / '').
 * `fetchImpl` is LATE-BOUND: resolved from `globalThis.fetch` at call time
 * when not supplied (per §2), since the default parameter is evaluated fresh
 * on every invocation rather than captured once.
 */
export async function defaultFetchPeerAgentKey(args: {
  peerBaseUrl: string
  handle: string
  fetchImpl?: typeof globalThis.fetch
}): Promise<PeerAgentKey> {
  const fetchImpl = args.fetchImpl ?? globalThis.fetch
  // Strip a trailing slash so we never produce //amtp/... (mirror attachment-pull).
  const base = args.peerBaseUrl.replace(/\/$/, '')
  const url = `${base}/amtp/agents/${encodeURIComponent(args.handle)}/key`

  let res: Response
  try {
    res = await fetchImpl(url, { method: 'GET', signal: AbortSignal.timeout(KEY_FETCH_TIMEOUT_MS) })
  } catch {
    throw new Error('PEER_KEY_FETCH_FAILED')
  }
  if (res.status < 200 || res.status >= 300) throw new Error('PEER_KEY_FETCH_FAILED')

  const body = (await res.json().catch(() => null)) as Partial<PeerAgentKey> | null
  if (!body || typeof body.identityPublicKey !== 'string' || !body.identityPublicKey) {
    throw new Error('PEER_KEY_FETCH_FAILED')
  }
  return {
    handle: typeof body.handle === 'string' ? body.handle : args.handle,
    instanceId: typeof body.instanceId === 'string' ? body.instanceId : '',
    identityPublicKey: body.identityPublicKey,
  }
}
