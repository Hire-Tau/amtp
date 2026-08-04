import { SIGNED_CARD_MAX_BYTES } from 'amtp-protocol'
import { CARD_FETCH_TIMEOUT_MS } from './options'

// ---------------------------------------------------------------------------
// §4.6 / §11 — default fetchPeerAgentCard implementation
// ---------------------------------------------------------------------------

/**
 * Public GET `<base>/amtp/agents/<encodeURIComponent(handle)>/card` — mirrors
 * `defaultFetchPeerAgentKey` (peer-key-fetch.ts), same unauthenticated route
 * shape as `serveAgentCard`'s serve side. `CARD_FETCH_TIMEOUT_MS` timeout;
 * throws `PEER_CARD_FETCH_FAILED` on network failure or a non-2xx status.
 *
 * Size is checked on the RAW response text's UTF-8 byte length, BEFORE
 * `JSON.parse` — the first of the spec §4.6 two-layer size gate (the second
 * layer, `signedCardByteSize` on the parsed+schema-validated value, lives in
 * `fetchPeerAgentCard` in discovery.ts). Oversized or unparseable bodies also
 * throw `PEER_CARD_FETCH_FAILED`. The parsed (but not yet schema-validated)
 * value is returned as `unknown` for the caller to validate.
 *
 * `fetchImpl` is LATE-BOUND: resolved from `globalThis.fetch` at call time
 * when not supplied (per §2), since the default parameter is evaluated fresh
 * on every invocation rather than captured once.
 */
export async function defaultFetchPeerAgentCard(args: {
  peerBaseUrl: string
  handle: string
  fetchImpl?: typeof globalThis.fetch
}): Promise<unknown> {
  const fetchImpl = args.fetchImpl ?? globalThis.fetch
  // Strip a trailing slash so we never produce //amtp/... (mirror peer-key-fetch).
  const base = args.peerBaseUrl.replace(/\/$/, '')
  const url = `${base}/amtp/agents/${encodeURIComponent(args.handle)}/card`

  let res: Response
  try {
    res = await fetchImpl(url, { method: 'GET', signal: AbortSignal.timeout(CARD_FETCH_TIMEOUT_MS) })
  } catch {
    throw new Error('PEER_CARD_FETCH_FAILED')
  }
  if (res.status < 200 || res.status >= 300) throw new Error('PEER_CARD_FETCH_FAILED')

  const text = await res.text()
  if (new TextEncoder().encode(text).length > SIGNED_CARD_MAX_BYTES) {
    throw new Error('PEER_CARD_FETCH_FAILED')
  }

  try {
    return JSON.parse(text)
  } catch {
    throw new Error('PEER_CARD_FETCH_FAILED')
  }
}
