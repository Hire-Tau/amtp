import { test, expect, describe } from 'bun:test'
import { defaultFetchPeerAgentCard } from './peer-card-fetch'

// ---------------------------------------------------------------------------
// §4.6 / §11 — defaultFetchPeerAgentCard: raw-size DoS gate + transport errors
// ---------------------------------------------------------------------------

describe('defaultFetchPeerAgentCard', () => {
  test('raw body over 16384 UTF-8 bytes throws PEER_CARD_FETCH_FAILED before JSON.parse', async () => {
    // Deliberately VALID JSON so the mutation gate is meaningful: if the size
    // gate were removed, JSON.parse would succeed on this body and the
    // function would RESOLVE (not throw) — causing this test to fail and
    // proving the size check (not a JSON.parse failure) is what rejects it.
    // (An invalid-JSON body doesn't work here: peer-card-fetch.ts's own
    // JSON.parse catch rethrows the identical 'PEER_CARD_FETCH_FAILED'
    // message, so a syntax-error body would pass this assertion even with
    // the size gate removed — it wouldn't isolate the gate at all.)
    const oversized = JSON.stringify({ padding: ' '.repeat(20000) })
    expect(new TextEncoder().encode(oversized).length).toBeGreaterThan(16384)

    const fetchImpl = (async () => new Response(oversized, { status: 200 })) as unknown as typeof fetch

    await expect(
      defaultFetchPeerAgentCard({ peerBaseUrl: 'https://peer.example', handle: 'alice', fetchImpl })
    ).rejects.toThrow('PEER_CARD_FETCH_FAILED')
  })

  test('non-2xx status throws', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 502 })) as unknown as typeof fetch
    await expect(
      defaultFetchPeerAgentCard({ peerBaseUrl: 'https://peer.example', handle: 'alice', fetchImpl })
    ).rejects.toThrow('PEER_CARD_FETCH_FAILED')
  })

  test('network reject throws', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    await expect(
      defaultFetchPeerAgentCard({ peerBaseUrl: 'https://peer.example', handle: 'alice', fetchImpl })
    ).rejects.toThrow('PEER_CARD_FETCH_FAILED')
  })

  test('non-JSON 200 body (small) throws', async () => {
    const fetchImpl = (async () => new Response('not json', { status: 200 })) as unknown as typeof fetch
    await expect(
      defaultFetchPeerAgentCard({ peerBaseUrl: 'https://peer.example', handle: 'alice', fetchImpl })
    ).rejects.toThrow('PEER_CARD_FETCH_FAILED')
  })

  test('valid small JSON resolves with the parsed value', async () => {
    const body = { v: 1, instanceId: 'peer-1', handle: 'alice', card: { name: 'Alice' }, cardSig: 'sig' }
    const fetchImpl = (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch
    const result = await defaultFetchPeerAgentCard({ peerBaseUrl: 'https://peer.example', handle: 'alice', fetchImpl })
    expect(result).toEqual(body)
  })

  test('encodeURIComponent applied to handle in the URL path', async () => {
    let capturedUrl: string | undefined
    const fetchImpl = (async (url: string) => {
      capturedUrl = url
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as unknown as typeof fetch

    await defaultFetchPeerAgentCard({ peerBaseUrl: 'https://peer.example', handle: 'a/b', fetchImpl })
    expect(capturedUrl).toBe('https://peer.example/amtp/agents/a%2Fb/card')
  })
})
