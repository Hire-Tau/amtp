import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { AmtpEnvelope } from 'amtp-protocol'
import type { OutboxStore } from '../ports'
import type { ContractTestPrimitives } from './index'

function fixtureEnvelope(overrides: Partial<AmtpEnvelope> = {}): AmtpEnvelope {
  return {
    v: 1,
    id: randomUUID(),
    ts: Date.now(),
    from: 'amtp://local-instance/alice',
    to: 'amtp://peer-1/bob',
    content: 'hello federation',
    ...overrides,
  }
}

/** §4.6 OutboxStore contract — idempotent enqueue; exclusive claims with
 *  stale-reclaim; claim-token-gated markers. */
export function runOutboxStoreContract(t: ContractTestPrimitives, make: () => Promise<OutboxStore>): void {
  t.describe('OutboxStore contract', () => {
    t.test('enqueue on a fresh idempotencyKey inserts a new entry', async () => {
      const store = await make()
      const envelope = fixtureEnvelope()
      const entry = await store.enqueue({
        peerInstanceId: 'peer-1',
        toAddress: envelope.to,
        envelope,
        idempotencyKey: envelope.id,
      })
      assert.equal(entry.envelope.id, envelope.id)
      assert.equal(entry.attempts, 0)
      assert.equal(entry.claimToken, null)
    })

    t.test('re-enqueuing the same idempotencyKey returns the EXISTING entry unchanged', async () => {
      const store = await make()
      const envelope = fixtureEnvelope()
      const first = await store.enqueue({
        peerInstanceId: 'peer-1',
        toAddress: envelope.to,
        envelope,
        idempotencyKey: envelope.id,
      })
      const second = await store.enqueue({
        peerInstanceId: 'peer-1',
        toAddress: envelope.to,
        envelope: fixtureEnvelope({ id: envelope.id, content: 'a different body — must be ignored' }),
        idempotencyKey: envelope.id,
      })
      assert.equal(second.id, first.id)
      assert.equal(second.envelope.content, envelope.content)
    })

    t.test('claimBatch returns a due-pending entry with a non-null claimToken', async () => {
      const store = await make()
      const envelope = fixtureEnvelope()
      await store.enqueue({ peerInstanceId: 'peer-1', toAddress: envelope.to, envelope, idempotencyKey: envelope.id })
      const claimed = await store.claimBatch(10, 300_000)
      assert.equal(claimed.length, 1)
      assert.ok(claimed[0].claimToken)
    })

    t.test('an already-claimed, non-stale entry is excluded from the next claimBatch', async () => {
      const store = await make()
      const envelope = fixtureEnvelope()
      await store.enqueue({ peerInstanceId: 'peer-1', toAddress: envelope.to, envelope, idempotencyKey: envelope.id })
      const first = await store.claimBatch(10, 300_000)
      assert.equal(first.length, 1)
      const second = await store.claimBatch(10, 300_000)
      assert.equal(second.length, 0)
    })

    t.test('concurrent claimers for a batch of entries never claim the same entry twice', async () => {
      const store = await make()
      for (let i = 0; i < 4; i += 1) {
        const envelope = fixtureEnvelope()
        await store.enqueue({
          peerInstanceId: 'peer-1',
          toAddress: envelope.to,
          envelope,
          idempotencyKey: envelope.id,
        })
      }
      const [batchA, batchB] = await Promise.all([store.claimBatch(2, 300_000), store.claimBatch(2, 300_000)])
      const claimedIds = [...batchA, ...batchB].map((e) => e.id)
      assert.equal(claimedIds.length, new Set(claimedIds).size)
      assert.equal(claimedIds.length, 4)
    })

    t.test('a stale-claimed entry (claimed longer than staleMs ago) is reclaimed with a FRESH claimToken', async () => {
      const store = await make()
      const envelope = fixtureEnvelope()
      await store.enqueue({ peerInstanceId: 'peer-1', toAddress: envelope.to, envelope, idempotencyKey: envelope.id })
      const [firstClaim] = await store.claimBatch(10, 5)
      await new Promise((resolve) => setTimeout(resolve, 20))
      const [reclaim] = await store.claimBatch(10, 5)
      assert.ok(reclaim)
      assert.notEqual(reclaim.claimToken, firstClaim.claimToken)
    })

    t.test('markDelivered with a mismatched claimToken is rejected (zombie-worker guard)', async () => {
      const store = await make()
      const envelope = fixtureEnvelope()
      await store.enqueue({ peerInstanceId: 'peer-1', toAddress: envelope.to, envelope, idempotencyKey: envelope.id })
      const [claimed] = await store.claimBatch(10, 300_000)
      const ok = await store.markDelivered(claimed.id, 'not-the-real-token')
      assert.equal(ok, false)
    })

    t.test('markDelivered with the matching claimToken succeeds', async () => {
      const store = await make()
      const envelope = fixtureEnvelope()
      await store.enqueue({ peerInstanceId: 'peer-1', toAddress: envelope.to, envelope, idempotencyKey: envelope.id })
      const [claimed] = await store.claimBatch(10, 300_000)
      const ok = await store.markDelivered(claimed.id, claimed.claimToken as string)
      assert.equal(ok, true)
    })

    t.test('markRetry schedules backoff — not immediately claimable', async () => {
      const store = await make()
      const envelope = fixtureEnvelope()
      await store.enqueue({ peerInstanceId: 'peer-1', toAddress: envelope.to, envelope, idempotencyKey: envelope.id })
      const [claimed] = await store.claimBatch(10, 300_000)
      const ok = await store.markRetry(claimed.id, claimed.claimToken as string, 'transient failure')
      assert.equal(ok, true)
      // §4.6/§3.3: markRetry schedules a future nextAttemptAt (min ~5s per the
      // reference backoff formula) — the entry must NOT be immediately
      // claimable again. This only asserts what the contract promises; it does
      // not assert a *positive* reclaim after the backoff elapses (that would
      // require a real sleep, which the kit does not do).
      const reclaimed = await store.claimBatch(10, 300_000)
      assert.equal(reclaimed.length, 0)
    })

    t.test('markFailedTerminal with a mismatched claimToken is rejected', async () => {
      const store = await make()
      const envelope = fixtureEnvelope()
      await store.enqueue({ peerInstanceId: 'peer-1', toAddress: envelope.to, envelope, idempotencyKey: envelope.id })
      const [claimed] = await store.claimBatch(10, 300_000)
      const ok = await store.markFailedTerminal(claimed.id, 'not-the-real-token', 'dead-lettered')
      assert.equal(ok, false)
    })

    t.test('hasOutboundAttachmentForPeer defaults to false when nothing was ever enqueued', async () => {
      const store = await make()
      assert.equal(await store.hasOutboundAttachmentForPeer('peer-1', 'att-1'), false)
    })
  })
}
