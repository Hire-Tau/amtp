import assert from 'node:assert/strict'
import type { PeerStore } from '../ports'
import type { ContractTestPrimitives } from './index'

export interface PeerRecord {
  baseUrl: string
  legacySignedGetPathPrefix?: string
  publicKeyPem: string
  status: string
}

/** §4.2 PeerStore contract. `getPeer` is the port's only method and is
 *  read-only, so the factory returns a `seed` hook alongside the store under
 *  test — hosts implement `seed` however they persist a trusted peer (e.g. an
 *  INSERT), independent of the store's own runtime API. */
export function runPeerStoreContract(
  t: ContractTestPrimitives,
  make: () => Promise<{
    store: PeerStore
    seed: (instanceId: string, peer: PeerRecord) => Promise<void> | void
  }>
): void {
  t.describe('PeerStore contract', () => {
    t.test('unknown instanceId resolves null', async () => {
      const { store } = await make()
      assert.equal(await store.getPeer('unknown-instance'), null)
    })

    t.test('a seeded peer resolves with its exact stored fields', async () => {
      const { store, seed } = await make()
      const peer: PeerRecord = { baseUrl: 'https://peer.example', publicKeyPem: 'peer-pub-key', status: 'active' }
      await seed('peer-1', peer)
      assert.deepEqual(await store.getPeer('peer-1'), peer)
    })

    t.test('status is an opaque string — a non-"active" value round-trips unchanged', async () => {
      const { store, seed } = await make()
      const peer: PeerRecord = { baseUrl: 'https://peer.example', publicKeyPem: 'peer-pub-key', status: 'disabled' }
      await seed('peer-2', peer)
      assert.deepEqual(await store.getPeer('peer-2'), peer)
    })

    t.test('distinct instanceIds are independent', async () => {
      const { store, seed } = await make()
      const peerA: PeerRecord = { baseUrl: 'https://a.example', publicKeyPem: 'key-a', status: 'active' }
      const peerB: PeerRecord = { baseUrl: 'https://b.example', publicKeyPem: 'key-b', status: 'active' }
      await seed('peer-a', peerA)
      await seed('peer-b', peerB)
      assert.deepEqual(await store.getPeer('peer-a'), peerA)
      assert.deepEqual(await store.getPeer('peer-b'), peerB)
    })
  })
}
