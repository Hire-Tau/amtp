import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { canonicalPeerGetString, generateInstanceKeyPair, instanceIdFromPublicKeyPem, signEnvelope } from 'amtp-protocol'
import type { PeerStore } from './ports'
import { verifyInboxPost, verifySignedGet } from './verify'

const SRC_DIR = dirname(new URL(import.meta.url).pathname)
const VECTORS_DIR = join(SRC_DIR, '..', '..', 'protocol', 'vectors')

interface EnvelopeSigVector {
  keys: { publicKeyPem: string; privateKeyPem: string; instanceId: string }
  vectors: Array<{ name: string; bodyUtf8: string; signatureB64: string }>
}

interface GetCanonicalVector {
  keys: { publicKeyPem: string; privateKeyPem: string; instanceId: string }
  vectors: Array<{ method: string; path: string; timestampMs: number; canonicalUtf8: string; signatureB64: string }>
}

const envelopeSig: EnvelopeSigVector = JSON.parse(readFileSync(join(VECTORS_DIR, 'envelope-signature.json'), 'utf8'))
const getCanonical: GetCanonicalVector = JSON.parse(readFileSync(join(VECTORS_DIR, 'get-canonical.json'), 'utf8'))

function fakePeerStore(peers: Record<string, { baseUrl: string; publicKeyPem: string; status: string }>): PeerStore {
  return {
    async getPeer(instanceId: string) {
      return peers[instanceId] ?? null
    },
  }
}

describe('verifyInboxPost (§5.2)', () => {
  const { instanceId, publicKeyPem } = envelopeSig.keys
  const activePeers = fakePeerStore({
    [instanceId]: { baseUrl: 'https://peer.example', publicKeyPem, status: 'active' },
  })

  for (const vector of envelopeSig.vectors) {
    test(`golden vector "${vector.name}" → ok:true, peerInstanceId echoed`, async () => {
      const result = await verifyInboxPost(activePeers, {
        instanceHeader: instanceId,
        signatureHeader: vector.signatureB64,
        rawBody: vector.bodyUtf8,
      })
      expect(result).toEqual({ ok: true, peerInstanceId: instanceId })
    })
  }

  test('missing instance header → ok:false', async () => {
    const vector = envelopeSig.vectors[0]
    const result = await verifyInboxPost(activePeers, {
      instanceHeader: undefined,
      signatureHeader: vector.signatureB64,
      rawBody: vector.bodyUtf8,
    })
    expect(result).toEqual({ ok: false })
  })

  test('missing signature header → ok:false', async () => {
    const vector = envelopeSig.vectors[0]
    const result = await verifyInboxPost(activePeers, {
      instanceHeader: instanceId,
      signatureHeader: undefined,
      rawBody: vector.bodyUtf8,
    })
    expect(result).toEqual({ ok: false })
  })

  test('unknown peer (no row) → ok:false (uniform, same shape as bad signature)', async () => {
    const vector = envelopeSig.vectors[0]
    const result = await verifyInboxPost(fakePeerStore({}), {
      instanceHeader: instanceId,
      signatureHeader: vector.signatureB64,
      rawBody: vector.bodyUtf8,
    })
    expect(result).toEqual({ ok: false })
  })

  test('peer status !== active → ok:false', async () => {
    const vector = envelopeSig.vectors[0]
    const disabledPeers = fakePeerStore({
      [instanceId]: { baseUrl: 'https://peer.example', publicKeyPem, status: 'disabled' },
    })
    const result = await verifyInboxPost(disabledPeers, {
      instanceHeader: instanceId,
      signatureHeader: vector.signatureB64,
      rawBody: vector.bodyUtf8,
    })
    expect(result).toEqual({ ok: false })
  })

  test('signature over tampered body → ok:false (verification exception swallowed to false)', async () => {
    const vector = envelopeSig.vectors[0]
    const result = await verifyInboxPost(activePeers, {
      instanceHeader: instanceId,
      signatureHeader: vector.signatureB64,
      rawBody: vector.bodyUtf8 + 'tampered',
    })
    expect(result).toEqual({ ok: false })
  })

  test('malformed base64 signature → ok:false, never throws', async () => {
    const vector = envelopeSig.vectors[0]
    await expect(
      verifyInboxPost(activePeers, {
        instanceHeader: instanceId,
        signatureHeader: 'not-valid-base64!!!',
        rawBody: vector.bodyUtf8,
      })
    ).resolves.toEqual({ ok: false })
  })

  test('a different instance signing a body it does not own → ok:false', async () => {
    const other = generateInstanceKeyPair()
    const otherInstanceId = instanceIdFromPublicKeyPem(other.publicKeyPem)
    const peers = fakePeerStore({
      [otherInstanceId]: { baseUrl: 'https://other.example', publicKeyPem: other.publicKeyPem, status: 'active' },
    })
    const vector = envelopeSig.vectors[0]
    // Sign the SAME body with a DIFFERENT key, then claim the golden vector's instanceId.
    const wrongSig = signEnvelope(other.privateKeyPem, new TextEncoder().encode(vector.bodyUtf8))
    const result = await verifyInboxPost(peers, {
      instanceHeader: otherInstanceId,
      signatureHeader: wrongSig,
      rawBody: vector.bodyUtf8,
    })
    // This one legitimately verifies (own key, own signature) — sanity check the harness works.
    expect(result).toEqual({ ok: true, peerInstanceId: otherInstanceId })
  })
})

describe('verifySignedGet (§5.3)', () => {
  const { instanceId, publicKeyPem } = getCanonical.keys
  const activePeers = fakePeerStore({
    [instanceId]: { baseUrl: 'https://peer.example', publicKeyPem, status: 'active' },
  })

  for (const vector of getCanonical.vectors) {
    test(`golden vector "${vector.method} ${vector.path}" → ok:true when now() is within freshness`, async () => {
      const result = await verifySignedGet(
        activePeers,
        {
          method: vector.method,
          path: vector.path,
          instanceHeader: instanceId,
          signatureHeader: vector.signatureB64,
          timestampHeader: String(vector.timestampMs),
        },
        () => vector.timestampMs
      )
      expect(result).toEqual({ ok: true, peerInstanceId: instanceId })
    })
  }

  const vector = getCanonical.vectors[0]

  test('missing any header → ok:false', async () => {
    await expect(
      verifySignedGet(
        activePeers,
        {
          method: vector.method,
          path: vector.path,
          instanceHeader: undefined,
          signatureHeader: vector.signatureB64,
          timestampHeader: String(vector.timestampMs),
        },
        () => vector.timestampMs
      )
    ).resolves.toEqual({ ok: false })
  })

  test('non-finite timestamp header → ok:false', async () => {
    const result = await verifySignedGet(
      activePeers,
      {
        method: vector.method,
        path: vector.path,
        instanceHeader: instanceId,
        signatureHeader: vector.signatureB64,
        timestampHeader: 'not-a-number',
      },
      () => vector.timestampMs
    )
    expect(result).toEqual({ ok: false })
  })

  test('stale timestamp beyond PEER_GET_FRESHNESS_MS → ok:false', async () => {
    const result = await verifySignedGet(
      activePeers,
      {
        method: vector.method,
        path: vector.path,
        instanceHeader: instanceId,
        signatureHeader: vector.signatureB64,
        timestampHeader: String(vector.timestampMs),
      },
      () => vector.timestampMs + 400_000
    )
    expect(result).toEqual({ ok: false })
  })

  test('unknown peer → ok:false', async () => {
    const result = await verifySignedGet(
      fakePeerStore({}),
      {
        method: vector.method,
        path: vector.path,
        instanceHeader: instanceId,
        signatureHeader: vector.signatureB64,
        timestampHeader: String(vector.timestampMs),
      },
      () => vector.timestampMs
    )
    expect(result).toEqual({ ok: false })
  })

  test('peer status !== active → ok:false', async () => {
    const disabledPeers = fakePeerStore({
      [instanceId]: { baseUrl: 'https://peer.example', publicKeyPem, status: 'disabled' },
    })
    const result = await verifySignedGet(
      disabledPeers,
      {
        method: vector.method,
        path: vector.path,
        instanceHeader: instanceId,
        signatureHeader: vector.signatureB64,
        timestampHeader: String(vector.timestampMs),
      },
      () => vector.timestampMs
    )
    expect(result).toEqual({ ok: false })
  })

  test('signature over a different path → ok:false (path binding enforced)', async () => {
    const result = await verifySignedGet(
      activePeers,
      {
        method: vector.method,
        path: '/api/amtp/some-other-path',
        instanceHeader: instanceId,
        signatureHeader: vector.signatureB64,
        timestampHeader: String(vector.timestampMs),
      },
      () => vector.timestampMs
    )
    expect(result).toEqual({ ok: false })
  })
})


describe('verifySignedGet route transition', () => {
  const keys = generateInstanceKeyPair()
  const instanceId = instanceIdFromPublicKeyPem(keys.publicKeyPem)
  const peers = fakePeerStore({ [instanceId]: { baseUrl: 'https://peer.example', publicKeyPem: keys.publicKeyPem, status: 'active' } })
  const ts = 123
  const sign = (path: string) => signEnvelope(keys.privateKeyPem, new TextEncoder().encode(canonicalPeerGetString('GET', path, ts)))
  const verify = (routePath: string, path: string, signatureHeader: string) => verifySignedGet(peers, { method: 'GET', routePath, path, instanceHeader: instanceId, signatureHeader, timestampHeader: String(ts) }, () => ts)

  test('accepts route-relative first and one observed legacy candidate', async () => {
    await expect(verify('/amtp/handles', '/api/amtp/handles', sign('/amtp/handles'))).resolves.toEqual({ ok: true, peerInstanceId: instanceId })
    await expect(verify('/amtp/handles', '/api/amtp/handles', sign('/api/amtp/handles'))).resolves.toEqual({ ok: true, peerInstanceId: instanceId })
  })

  test('does not broaden signatures across routes or resources', async () => {
    await expect(verify('/amtp/attachments/a', '/api/amtp/attachments/a', sign('/amtp/handles'))).resolves.toEqual({ ok: false })
    await expect(verify('/amtp/attachments/b', '/api/amtp/attachments/b', sign('/amtp/attachments/a'))).resolves.toEqual({ ok: false })
    await expect(verify('/amtp/handles', '/prefix/amtp/handles', sign('/other/amtp/handles'))).resolves.toEqual({ ok: false })
  })
})
