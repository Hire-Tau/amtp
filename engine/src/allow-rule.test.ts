import { describe, expect, test } from 'bun:test'
import { matchesAllowRule } from './allow-rule'

// Cases ported from the reference allow-rule matching semantics
// (`isSenderAllowed`'s original SQL predicate):
// a rule matches iff its peerInstanceId equals the sender's peerInstanceId
// AND (principalKind is 'any', or principalKind is 'handle' with
// principalValue equal to the sender's handle).

describe('matchesAllowRule', () => {
  test('any-kind rule matches any sender handle from the same peer', () => {
    const rule = { peerInstanceId: 'peer-a', principalKind: 'any' as const, principalValue: null }
    expect(matchesAllowRule(rule, { peerInstanceId: 'peer-a', senderHandle: 'alice' })).toBe(true)
    expect(matchesAllowRule(rule, { peerInstanceId: 'peer-a', senderHandle: 'bob' })).toBe(true)
  })

  test('handle-kind rule matches only the exact sender handle', () => {
    const rule = { peerInstanceId: 'peer-a', principalKind: 'handle' as const, principalValue: 'alice' }
    expect(matchesAllowRule(rule, { peerInstanceId: 'peer-a', senderHandle: 'alice' })).toBe(true)
  })

  test('handle-kind rule does not match a different sender handle', () => {
    const rule = { peerInstanceId: 'peer-a', principalKind: 'handle' as const, principalValue: 'alice' }
    expect(matchesAllowRule(rule, { peerInstanceId: 'peer-a', senderHandle: 'bob' })).toBe(false)
  })

  test('a rule for a different peer never matches, regardless of kind', () => {
    const anyRule = { peerInstanceId: 'peer-a', principalKind: 'any' as const, principalValue: null }
    expect(matchesAllowRule(anyRule, { peerInstanceId: 'peer-b', senderHandle: 'alice' })).toBe(false)

    const handleRule = { peerInstanceId: 'peer-a', principalKind: 'handle' as const, principalValue: 'alice' }
    expect(matchesAllowRule(handleRule, { peerInstanceId: 'peer-b', senderHandle: 'alice' })).toBe(false)
  })

  test('handle-kind rule with a null principalValue never matches', () => {
    const rule = { peerInstanceId: 'peer-a', principalKind: 'handle' as const, principalValue: null }
    expect(matchesAllowRule(rule, { peerInstanceId: 'peer-a', senderHandle: 'alice' })).toBe(false)
  })
})
