import assert from 'node:assert/strict'
import type { ReplayLedger } from '../ports'
import type { ContractTestPrimitives } from './index'

/** §4.5 ReplayLedger contract — atomic record-if-new, idempotent unrecord. */
export function runReplayLedgerContract(t: ContractTestPrimitives, make: () => Promise<ReplayLedger>): void {
  t.describe('ReplayLedger contract', () => {
    t.test('first sighting of (peer, envelopeId) records and returns true', async () => {
      const ledger = await make()
      assert.equal(await ledger.recordIfNew('peer-1', 'env-1'), true)
    })

    t.test('re-recording the same (peer, envelopeId) returns false', async () => {
      const ledger = await make()
      await ledger.recordIfNew('peer-1', 'env-1')
      assert.equal(await ledger.recordIfNew('peer-1', 'env-1'), false)
    })

    t.test('concurrent recordIfNew for the same key: exactly one call observes true', async () => {
      const ledger = await make()
      const results = await Promise.all(Array.from({ length: 5 }, () => ledger.recordIfNew('peer-1', 'env-race')))
      assert.equal(results.filter(Boolean).length, 1)
    })

    t.test('distinct envelopeIds under the same peer are independent', async () => {
      const ledger = await make()
      assert.equal(await ledger.recordIfNew('peer-1', 'env-a'), true)
      assert.equal(await ledger.recordIfNew('peer-1', 'env-b'), true)
    })

    t.test('the same envelopeId under a different peer is independent', async () => {
      const ledger = await make()
      await ledger.recordIfNew('peer-1', 'env-1')
      assert.equal(await ledger.recordIfNew('peer-2', 'env-1'), true)
    })

    t.test('unrecord releases the slot: a subsequent recordIfNew is a fresh first sighting', async () => {
      const ledger = await make()
      await ledger.recordIfNew('peer-1', 'env-1')
      await ledger.unrecord('peer-1', 'env-1')
      assert.equal(await ledger.recordIfNew('peer-1', 'env-1'), true)
    })

    t.test('unrecord on an already-gone (or never-recorded) entry does not throw', async () => {
      const ledger = await make()
      await ledger.unrecord('peer-1', 'never-recorded')
    })
  })
}
