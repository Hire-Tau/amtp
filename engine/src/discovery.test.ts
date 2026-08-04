import { test, expect, describe } from 'bun:test'
import { generateInstanceKeyPair, signAgentCard } from 'amtp-protocol'
import { fetchPeerAgentCard, listHandles, serveAgentCard } from './discovery'
import type { FetchPeerAgentCardRuntime } from './discovery'
import type { AmtpEnginePorts } from './options'
import { testing } from './index'

test('listHandles carries name/description hints derived from stored cards', async () => {
  const handles = testing.makeHandleDirectory()
  handles.set('alice', { recipientRef: 'r', inboundOpen: true, agentPublicKeyPem: 'k' })
  handles.setCard('alice', {
    v: 1,
    instanceId: 'i',
    handle: 'alice',
    card: { name: 'Alice', description: 'Support' },
    cardSig: 'sig',
  })
  handles.set('bob', { recipientRef: 'r2', inboundOpen: false, agentPublicKeyPem: null })
  const ports = { handles } as never
  expect(await listHandles(ports)).toEqual({
    handles: [{ handle: 'alice', name: 'Alice', description: 'Support' }, { handle: 'bob' }],
  })
})

test('serveAgentCard returns the stored card verbatim; found:false when absent', async () => {
  const handles = testing.makeHandleDirectory()
  handles.set('alice', { recipientRef: 'r', inboundOpen: true, agentPublicKeyPem: 'k' })
  const ports = { handles } as never
  expect(await serveAgentCard(ports, 'alice')).toEqual({ found: false })
  const signed = { v: 1 as const, instanceId: 'i', handle: 'alice', card: { name: 'A' }, cardSig: 's' }
  handles.setCard('alice', signed)
  expect(await serveAgentCard(ports, 'alice')).toEqual({ found: true, signedCard: signed })
})

// ---------------------------------------------------------------------------
// §4.6 fetchPeerAgentCard — client-side verified fetch
// ---------------------------------------------------------------------------

const agentKeys = generateInstanceKeyPair()
const sansSig = { v: 1 as const, instanceId: 'peer-1', handle: 'alice', card: { name: 'Alice' } }
const signedCard = { ...sansSig, cardSig: signAgentCard(agentKeys.privateKeyPem, sansSig) }

function makePorts(): AmtpEnginePorts {
  const peers = testing.makePeerStore()
  peers.set('peer-1', { baseUrl: 'http://peer', publicKeyPem: 'peer-key', status: 'active' })
  const pins = testing.makePinStore()
  return { peers, pins } as never
}

function runtime(card: unknown): FetchPeerAgentCardRuntime {
  return {
    now: () => 0,
    overrides: {
      fetchPeerAgentCard: async () => card,
      fetchPeerAgentKey: async () => ({
        handle: 'alice',
        instanceId: 'peer-1',
        identityPublicKey: agentKeys.publicKeyPem,
      }),
    },
  }
}

describe('fetchPeerAgentCard', () => {
  test('verified card round-trip pins the key on first use', async () => {
    const ports = makePorts()
    const result = await fetchPeerAgentCard(ports, runtime(signedCard), { peerInstanceId: 'peer-1', handle: 'alice' })
    expect(result).toEqual({ ok: true, card: signedCard.card, signedCard })
    expect(await ports.pins.getPin('peer-1', 'alice')).toBe(agentKeys.publicKeyPem)
  })

  test('binding mismatch (instanceId or handle) is rejected', async () => {
    expect(
      await fetchPeerAgentCard(makePorts(), runtime({ ...signedCard, handle: 'bob' }), {
        peerInstanceId: 'peer-1',
        handle: 'alice',
      })
    ).toEqual({ ok: false })
    expect(
      await fetchPeerAgentCard(makePorts(), runtime(signedCard), { peerInstanceId: 'other-peer', handle: 'alice' })
    ).toEqual({ ok: false })
  })

  test('wrong pinned key, bad schema, unknown peer, thrown fetch all yield ok:false', async () => {
    const ports = makePorts()
    await ports.pins.recordPinIfNew('peer-1', 'alice', 'WRONG-KEY')
    expect(await fetchPeerAgentCard(ports, runtime(signedCard), { peerInstanceId: 'peer-1', handle: 'alice' })).toEqual(
      {
        ok: false,
      }
    )
    expect(
      await fetchPeerAgentCard(makePorts(), runtime({ nope: true }), { peerInstanceId: 'peer-1', handle: 'alice' })
    ).toEqual({ ok: false })
    expect(
      await fetchPeerAgentCard(makePorts(), runtime(signedCard), { peerInstanceId: 'ghost', handle: 'alice' })
    ).toEqual({ ok: false })
    const throwing: FetchPeerAgentCardRuntime = {
      now: () => 0,
      overrides: {
        fetchPeerAgentCard: async () => {
          throw new Error('net')
        },
      },
    }
    expect(await fetchPeerAgentCard(makePorts(), throwing, { peerInstanceId: 'peer-1', handle: 'alice' })).toEqual({
      ok: false,
    })
  })

  test('oversized card is rejected', async () => {
    const fat = { ...sansSig, card: { name: 'A', extensions: { blob: 'x'.repeat(20000) } } }
    const fatSigned = { ...fat, cardSig: signAgentCard(agentKeys.privateKeyPem, fat) }
    expect(
      await fetchPeerAgentCard(makePorts(), runtime(fatSigned), { peerInstanceId: 'peer-1', handle: 'alice' })
    ).toEqual({ ok: false })
  })

  // The above 'binding mismatch' test is NOT load-bearing for the binding
  // check itself: its handle case mutates the top-level `handle` after
  // signing, so it's actually caught by the Ed25519 signature check; its
  // instanceId case targets a peerInstanceId that was never registered, so
  // it's caught by the `getPeer` guard. These tests isolate the binding line
  // (`signedCard.instanceId !== args.peerInstanceId || signedCard.handle !==
  // args.handle`) by keeping the card VALIDLY signed over its own claimed
  // (instanceId, handle) — so the signature check passes — while requesting
  // a different (instanceId, handle) pair whose peer IS registered — so the
  // getPeer guard passes too. Only the binding check can reject these.
  describe('binding check is load-bearing (isolated from sig/getPeer guards)', () => {
    const isoKeys = generateInstanceKeyPair()
    const isoSansSig = { v: 1 as const, instanceId: 'peer-1', handle: 'alice', card: { name: 'Alice' } }
    const isoSignedCard = { ...isoSansSig, cardSig: signAgentCard(isoKeys.privateKeyPem, isoSansSig) }

    function isoRuntime(): FetchPeerAgentCardRuntime {
      return {
        now: () => 0,
        overrides: {
          fetchPeerAgentCard: async () => isoSignedCard,
          fetchPeerAgentKey: async () => ({
            handle: 'alice',
            instanceId: 'peer-1',
            identityPublicKey: isoKeys.publicKeyPem,
          }),
        },
      }
    }

    test('handle mismatch: card validly signed for (peer-1, alice), request asks for (peer-1, bob)', async () => {
      const peers = testing.makePeerStore()
      peers.set('peer-1', { baseUrl: 'http://peer', publicKeyPem: 'peer-key', status: 'active' })
      const pins = testing.makePinStore()
      const ports = { peers, pins } as unknown as AmtpEnginePorts

      const result = await fetchPeerAgentCard(ports, isoRuntime(), { peerInstanceId: 'peer-1', handle: 'bob' })
      expect(result).toEqual({ ok: false })
    })

    test('instanceId mismatch: card validly signed for (peer-1, alice), request asks for (peer-2, alice)', async () => {
      const peers = testing.makePeerStore()
      // peer-2 must be registered so getPeer succeeds and doesn't mask the binding check.
      peers.set('peer-2', { baseUrl: 'http://peer2', publicKeyPem: 'peer2-key', status: 'active' })
      const pins = testing.makePinStore()
      const ports = { peers, pins } as unknown as AmtpEnginePorts

      const result = await fetchPeerAgentCard(ports, isoRuntime(), { peerInstanceId: 'peer-2', handle: 'alice' })
      expect(result).toEqual({ ok: false })
    })
  })
})
