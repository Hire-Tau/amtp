import {
  AMTP_HEADER_INSTANCE,
  AMTP_HEADER_SIGNATURE,
  AMTP_HEADER_TIMESTAMP,
  CARD_DESCRIPTION_MAX,
  CARD_NAME_MAX,
  SIGNED_CARD_MAX_BYTES,
  amtpSignedAgentCardSchema,
  canonicalPeerGetString,
  signEnvelope,
  verifyAgentCard,
  signedCardByteSize,
} from 'amtp-protocol'
import type { AmtpSignedAgentCard } from 'amtp-protocol'
import { HANDLES_FETCH_TIMEOUT_MS } from './options'
import type { AmtpEngineOptions, AmtpEnginePorts } from './options'
import { defaultFetchPeerAgentCard } from './peer-card-fetch'
import { defaultFetchPeerAgentKey } from './peer-key-fetch'
import type { HandleListing } from './ports'
import type {
  FetchPeerAgentCardResult,
  FetchPeerHandlesResult,
  ServeAgentCardResult,
  ServeAgentKeyResult,
} from './results'

// ---------------------------------------------------------------------------
// §5.6 listHandles (§11 serve)
// ---------------------------------------------------------------------------

/** Ported from routes/amtp.ts:185-188. Host authenticates with verifySignedGet first. */
export async function listHandles(ports: AmtpEnginePorts): Promise<{ handles: HandleListing[] }> {
  const entries = await ports.handles.list()
  return {
    handles: entries.map((e) => {
      const item: HandleListing = { handle: e.handle }
      if (typeof e.name === 'string' && e.name.length > 0 && e.name.length <= CARD_NAME_MAX) item.name = e.name
      if (typeof e.description === 'string' && e.description.length > 0 && e.description.length <= CARD_DESCRIPTION_MAX)
        item.description = e.description
      return item
    }),
  }
}

// ---------------------------------------------------------------------------
// §5.7 serveAgentKey (§4.3 serve)
// ---------------------------------------------------------------------------

/**
 * Ported from routes/amtp.ts:174-180. Public route — no auth. `handle` in the
 * result is the ECHOED request handle (the exact-match lookup guarantees it
 * equals `resolved`'s own handle, so there's nothing else to echo from the
 * port's return value).
 */
export async function serveAgentKey(ports: AmtpEnginePorts, handle: string): Promise<ServeAgentKeyResult> {
  const resolved = await ports.handles.resolve(handle)
  if (!resolved || !resolved.agentPublicKeyPem) return { found: false }

  const identity = await ports.identity.get()
  return { found: true, handle, instanceId: identity.instanceId, identityPublicKey: resolved.agentPublicKeyPem }
}

// ---------------------------------------------------------------------------
// §4.6 serveAgentCard — serve the published card verbatim (never re-sign).
// ---------------------------------------------------------------------------

export async function serveAgentCard(ports: AmtpEnginePorts, handle: string): Promise<ServeAgentCardResult> {
  const signedCard = await ports.handles.getCard(handle)
  if (!signedCard) return { found: false }
  return { found: true, signedCard }
}

// ---------------------------------------------------------------------------
// §5.8 fetchPeerHandles (§11 client)
// ---------------------------------------------------------------------------

export interface FetchPeerHandlesRuntime {
  now: () => number
  /** Late-bound per §2 — resolved at the fetch call site, not here. */
  fetch?: typeof globalThis.fetch
}

/**
 * Signed GET to `stripTrailingSlash(peerBaseUrl) + '/amtp/handles'` (canonical
 * over the full URL's pathname), `HANDLES_FETCH_TIMEOUT_MS` timeout.
 * `{ok:false}` on network throw, non-2xx, unparseable JSON, or `handles` not
 * an array; items filtered to `typeof h.handle === 'string'`. Ported from
 * services/amtp/peer-handles.ts:22-63.
 */
export async function fetchPeerHandles(
  ports: AmtpEnginePorts,
  runtime: FetchPeerHandlesRuntime,
  args: { peerBaseUrl: string }
): Promise<FetchPeerHandlesResult> {
  const signing = await ports.identity.getSigning()

  const base = args.peerBaseUrl.replace(/\/$/, '')
  const url = `${base}/amtp/handles`
  const ts = runtime.now()
  const canonical = canonicalPeerGetString('GET', new URL(url).pathname, ts)
  const signature = signEnvelope(signing.privateKeyPem, new TextEncoder().encode(canonical))

  const fetchImpl = runtime.fetch ?? globalThis.fetch

  let res: Response
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      headers: {
        [AMTP_HEADER_INSTANCE]: signing.instanceId,
        [AMTP_HEADER_SIGNATURE]: signature,
        [AMTP_HEADER_TIMESTAMP]: String(ts),
      },
      signal: AbortSignal.timeout(HANDLES_FETCH_TIMEOUT_MS),
    })
  } catch {
    return { ok: false }
  }
  if (res.status < 200 || res.status >= 300) return { ok: false }

  let body: unknown
  try {
    body = await res.json()
  } catch {
    return { ok: false }
  }

  const handles = (body as { handles?: unknown } | null)?.handles
  if (!Array.isArray(handles)) return { ok: false }

  return {
    ok: true,
    handles: handles
      .filter(
        (h): h is { handle: string; name?: unknown; description?: unknown } =>
          typeof (h as { handle?: unknown })?.handle === 'string'
      )
      .map((h) => {
        const item: HandleListing = { handle: h.handle }
        if (typeof h.name === 'string' && h.name.length > 0 && h.name.length <= CARD_NAME_MAX) item.name = h.name
        if (
          typeof h.description === 'string' &&
          h.description.length > 0 &&
          h.description.length <= CARD_DESCRIPTION_MAX
        )
          item.description = h.description
        return item
      }),
  }
}

// ---------------------------------------------------------------------------
// §4.6 fetchPeerAgentCard (§11 client) — verified client-side card fetch
// ---------------------------------------------------------------------------

export interface FetchPeerAgentCardRuntime {
  now: () => number
  /** Late-bound per §2 — resolved by the network-op call sites, not here. */
  fetch?: typeof globalThis.fetch
  overrides?: AmtpEngineOptions['overrides']
}

/**
 * Client-side verified card fetch (spec §4.6 Verifying): size check (both
 * layers — raw bytes in `defaultFetchPeerAgentCard`, then
 * `signedCardByteSize` on the parsed value here) → schema →
 * instanceId/handle binding → TOFU pin (same pin path as `receiveEnvelope`
 * step 7 — getPin, else fetch + recordPinIfNew) → Ed25519 verify.
 */
export async function fetchPeerAgentCard(
  ports: AmtpEnginePorts,
  runtime: FetchPeerAgentCardRuntime,
  args: { peerInstanceId: string; handle: string }
): Promise<FetchPeerAgentCardResult> {
  const peer = await ports.peers.getPeer(args.peerInstanceId)
  if (!peer) return { ok: false }

  const fetchCard =
    runtime.overrides?.fetchPeerAgentCard ??
    ((a: { peerBaseUrl: string; handle: string }) => defaultFetchPeerAgentCard({ ...a, fetchImpl: runtime.fetch }))
  let raw: unknown
  try {
    raw = await fetchCard({ peerBaseUrl: peer.baseUrl, handle: args.handle })
  } catch {
    return { ok: false }
  }

  const parsed = amtpSignedAgentCardSchema.safeParse(raw)
  if (!parsed.success) return { ok: false }
  const signedCard = parsed.data as AmtpSignedAgentCard
  // Binding: the card must be FOR this peer and handle (spec §4.6 Verifying).
  if (signedCard.instanceId !== args.peerInstanceId || signedCard.handle !== args.handle) return { ok: false }
  if (signedCardByteSize(signedCard) > SIGNED_CARD_MAX_BYTES) return { ok: false }

  // TOFU: same pin path as receive step 7 (getPin → key fetch → recordPinIfNew).
  let pinned = await ports.pins.getPin(args.peerInstanceId, args.handle)
  if (!pinned) {
    const fetchKey =
      runtime.overrides?.fetchPeerAgentKey ??
      ((a: { peerBaseUrl: string; handle: string }) => defaultFetchPeerAgentKey({ ...a, fetchImpl: runtime.fetch }))
    try {
      const fetched = await fetchKey({ peerBaseUrl: peer.baseUrl, handle: args.handle })
      pinned = await ports.pins.recordPinIfNew(args.peerInstanceId, args.handle, fetched.identityPublicKey)
    } catch {
      return { ok: false }
    }
  }

  if (!verifyAgentCard(pinned, signedCard)) return { ok: false }
  return { ok: true, card: signedCard.card, signedCard }
}
