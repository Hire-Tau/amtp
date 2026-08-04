import assert from 'node:assert/strict'
import type { PinStore } from '../ports'
import type { ContractTestPrimitives } from './index'

/** §4.3 PinStore (TOFU) contract — first-write-wins, race-safe. */
export function runPinStoreContract(t: ContractTestPrimitives, make: () => Promise<PinStore>): void {
  t.describe('PinStore contract', () => {
    t.test('an unpinned (peer, handle) resolves null', async () => {
      const store = await make()
      assert.equal(await store.getPin('peer-1', 'alice'), null)
    })

    t.test('recordPinIfNew on an unpinned handle stores and returns the given key', async () => {
      const store = await make()
      const result = await store.recordPinIfNew('peer-1', 'alice', 'key-A')
      assert.equal(result, 'key-A')
      assert.equal(await store.getPin('peer-1', 'alice'), 'key-A')
    })

    t.test('recordPinIfNew is idempotent when re-called with the identical key', async () => {
      const store = await make()
      await store.recordPinIfNew('peer-1', 'alice', 'key-A')
      const result = await store.recordPinIfNew('peer-1', 'alice', 'key-A')
      assert.equal(result, 'key-A')
    })

    t.test('recordPinIfNew with a DIFFERENT key does not overwrite — the first-seen pin wins', async () => {
      const store = await make()
      await store.recordPinIfNew('peer-1', 'alice', 'key-A')
      const result = await store.recordPinIfNew('peer-1', 'alice', 'key-B')
      assert.equal(result, 'key-A')
      assert.equal(await store.getPin('peer-1', 'alice'), 'key-A')
    })

    t.test('concurrent first-contact race: interleaved recordPinIfNew calls converge on ONE winning pin', async () => {
      const store = await make()
      const results = await Promise.all([
        store.recordPinIfNew('peer-1', 'bob', 'key-1'),
        store.recordPinIfNew('peer-1', 'bob', 'key-2'),
        store.recordPinIfNew('peer-1', 'bob', 'key-3'),
      ])
      const [winner] = results
      assert.ok(results.every((r) => r === winner))
      assert.equal(await store.getPin('peer-1', 'bob'), winner)
    })

    t.test('pins are scoped per (peer, handle) — same handle under a different peer is independent', async () => {
      const store = await make()
      await store.recordPinIfNew('peer-1', 'alice', 'key-A')
      await store.recordPinIfNew('peer-2', 'alice', 'key-Z')
      assert.equal(await store.getPin('peer-1', 'alice'), 'key-A')
      assert.equal(await store.getPin('peer-2', 'alice'), 'key-Z')
    })
  })
}
