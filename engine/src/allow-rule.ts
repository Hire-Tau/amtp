// ---------------------------------------------------------------------------
// §4.9 — pure reference allow-rule matcher
// ---------------------------------------------------------------------------
//
// The reference allow-rule predicate (`isSenderAllowed`), factored out of its
// original SQL query into a pure function so hosts can build their
// `ReceivePolicy.isReceiveAllowed` on it (the node host uses it directly; SQL
// implementations are checked against it by the contract-test kit, §4.12).

/**
 * True iff `rule.peerInstanceId === sender.peerInstanceId` AND
 * (`principalKind === 'any'`, or `principalKind === 'handle'` and
 * `principalValue === sender.senderHandle`).
 */
export function matchesAllowRule(
  rule: { peerInstanceId: string; principalKind: 'any' | 'handle'; principalValue?: string | null },
  sender: { peerInstanceId: string; senderHandle: string }
): boolean {
  if (rule.peerInstanceId !== sender.peerInstanceId) return false
  if (rule.principalKind === 'any') return true
  return rule.principalValue === sender.senderHandle
}
