// Port/hook conformance-suite kit for hosts (§4.12). Every suite is a plain
// function that takes injected test-registration primitives (so this kit
// stays runner-agnostic and the package's purity gate is unaffected — no
// `bun:test` import here; assertions are done via `node:assert`, which is
// already an allowed specifier) plus a factory that builds a fresh port
// instance to test. Hosts (the node host, this package's own
// `kit.test.ts`, and any external adapter) supply the runner's own `describe`/`test` and wire the
// factory to their adapter.

/** The only two primitives a host's test runner must supply. Deliberately
 *  narrow — assertions inside each suite use `node:assert`, not an injected
 *  `expect`, so this type is trivially satisfiable by bun:test, vitest,
 *  jest, or node:test's `describe`/`test`/`it`. */
export interface ContractTestPrimitives {
  describe: (name: string, fn: () => void) => void
  test: (name: string, fn: () => void | Promise<void>) => void
}

export { runPeerStoreContract } from './peer-store'
export type { PeerRecord } from './peer-store'
export { runPinStoreContract } from './pin-store'
export { runReplayLedgerContract } from './replay-ledger'
export { runOutboxStoreContract } from './outbox-store'
export { runAttachmentStoreContract } from './attachment-store'
export type { AttachmentBlob } from './attachment-store'
export { runHandleDirectoryContract } from './handle-directory'
export type { HandleRecord } from './handle-directory'
export { runReceivePolicyContract } from './receive-policy'
export type { AllowRuleRecord } from './receive-policy'
export { runDeliveryHooksContract } from './delivery-hooks'
export type { DeliveryHooksProbes } from './delivery-hooks'
