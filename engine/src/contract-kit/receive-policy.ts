import assert from 'node:assert/strict'
import { matchesAllowRule } from '../allow-rule'
import type { ReceivePolicy } from '../ports'
import type { ContractTestPrimitives } from './index'

export interface AllowRuleRecord {
  peerInstanceId: string
  principalKind: 'any' | 'handle'
  principalValue?: string | null
}

/** §4.9 ReceivePolicy contract — the leakage target §4.12 calls out: the
 *  host's `isReceiveAllowed` MUST agree with the exported reference matcher
 *  `matchesAllowRule` over a rule/sender matrix (any/handle kinds, plus the
 *  default-deny path). `seed` records an allow-rule against `recipientRef`
 *  however the host persists rules (a DB row, or in the node host an
 *  in-memory list) — the suite only drives `isReceiveAllowed`, never reads
 *  rules back directly. */
export function runReceivePolicyContract(
  t: ContractTestPrimitives,
  make: () => Promise<{
    policy: ReceivePolicy
    seed: (recipientRef: string, rule: AllowRuleRecord) => Promise<void> | void
  }>
): void {
  t.describe('ReceivePolicy contract — isReceiveAllowed agrees with matchesAllowRule', () => {
    t.test("a rule for the sender's peer with kind 'any' allows receipt", async () => {
      const { policy, seed } = await make()
      await seed('agent-1', { peerInstanceId: 'peer-1', principalKind: 'any' })
      const allowed = await policy.isReceiveAllowed({
        recipientRef: 'agent-1',
        peerInstanceId: 'peer-1',
        senderHandle: 'alice',
      })
      assert.equal(
        allowed,
        matchesAllowRule(
          { peerInstanceId: 'peer-1', principalKind: 'any' },
          { peerInstanceId: 'peer-1', senderHandle: 'alice' }
        )
      )
      assert.equal(allowed, true)
    })

    t.test("a rule for the sender's peer with kind 'handle' matching the sender allows receipt", async () => {
      const { policy, seed } = await make()
      await seed('agent-1', { peerInstanceId: 'peer-1', principalKind: 'handle', principalValue: 'alice' })
      const allowed = await policy.isReceiveAllowed({
        recipientRef: 'agent-1',
        peerInstanceId: 'peer-1',
        senderHandle: 'alice',
      })
      assert.equal(allowed, true)
    })

    t.test("a rule for the sender's peer with kind 'handle' NOT matching the sender denies receipt", async () => {
      const { policy, seed } = await make()
      await seed('agent-1', { peerInstanceId: 'peer-1', principalKind: 'handle', principalValue: 'bob' })
      const allowed = await policy.isReceiveAllowed({
        recipientRef: 'agent-1',
        peerInstanceId: 'peer-1',
        senderHandle: 'alice',
      })
      assert.equal(allowed, false)
    })

    t.test('a rule for a DIFFERENT peer (any kind) denies receipt', async () => {
      const { policy, seed } = await make()
      await seed('agent-1', { peerInstanceId: 'peer-OTHER', principalKind: 'any' })
      const allowed = await policy.isReceiveAllowed({
        recipientRef: 'agent-1',
        peerInstanceId: 'peer-1',
        senderHandle: 'alice',
      })
      assert.equal(allowed, false)
    })

    t.test('no rules at all denies receipt (default deny)', async () => {
      const { policy } = await make()
      const allowed = await policy.isReceiveAllowed({
        recipientRef: 'agent-1',
        peerInstanceId: 'peer-1',
        senderHandle: 'alice',
      })
      assert.equal(allowed, false)
    })
  })
}
