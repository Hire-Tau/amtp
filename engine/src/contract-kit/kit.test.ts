import { describe, test } from 'bun:test'
import {
  runAttachmentStoreContract,
  runDeliveryHooksContract,
  runHandleDirectoryContract,
  runOutboxStoreContract,
  runPeerStoreContract,
  runPinStoreContract,
  runReceivePolicyContract,
  runReplayLedgerContract,
} from './index'
import {
  makeAttachmentStore,
  makeDeliveryHooksWithRollback,
  makeHandleDirectory,
  makeOutboxStore,
  makePeerStore,
  makePinStore,
  makeReceivePolicy,
  makeReplayLedger,
} from '../testing/fakes'

// Proves the contract kit (§4.12) passes against this package's own
// in-memory fakes (src/testing/fakes.ts) — the same fakes receive.test.ts,
// outbox.test.ts, and serve.test.ts use. `describe`/`test` are bun:test's,
// injected exactly as any other host's runner would be — the kit itself
// never imports bun:test (see purity.test.ts).
const t = { describe, test }

runPeerStoreContract(t, async () => {
  const peers = makePeerStore()
  return { store: peers, seed: (id, peer) => peers.set(id, peer) }
})

runPinStoreContract(t, async () => makePinStore())

runReplayLedgerContract(t, async () => makeReplayLedger())

runOutboxStoreContract(t, async () => makeOutboxStore())

runAttachmentStoreContract(t, async () => {
  const attachments = makeAttachmentStore()
  return {
    store: attachments,
    seedBlob: (id, blob) => {
      attachments.blobs.set(id, blob)
    },
    seedStoredBytes: (bytes) => attachments.setStoredBytes(bytes),
  }
})

runDeliveryHooksContract(t, async (opts) => {
  const hooks = makeDeliveryHooksWithRollback(opts)
  return { hooks, probes: hooks.probes }
})

runHandleDirectoryContract(t, async () => {
  const handles = makeHandleDirectory()
  return {
    directory: handles,
    seed: (handle, record) => handles.set(handle, record),
    seedTerminated: (handle) => handles.delete(handle),
    seedCard: (handle, signedCard) => handles.setCard(handle, signedCard),
  }
})

runReceivePolicyContract(t, async () => {
  const policy = makeReceivePolicy()
  return {
    policy,
    seed: (recipientRef, rule) => policy.seedRule(recipientRef, rule),
  }
})
