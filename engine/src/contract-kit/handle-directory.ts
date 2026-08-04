import assert from 'node:assert/strict'
import type { AmtpSignedAgentCard } from 'amtp-protocol'
import type { HandleDirectory } from '../ports'
import type { ContractTestPrimitives } from './index'

export interface HandleRecord {
  recipientRef: string
  inboundOpen: boolean
  agentPublicKeyPem: string | null
}

/** §4.8 HandleDirectory contract. Both methods are read-only, so the factory
 *  returns a `seed` hook alongside the directory under test — hosts implement
 *  `seed` however they register a handle (e.g. an INSERT), independent of the
 *  directory's own runtime API. `seedTerminated` is optional: it marks an
 *  already-seeded handle as terminated/unregistered so the suite can assert
 *  it's excluded from resolve/list (§4.8: "resolve MUST only return live
 *  registrations"); hosts that can't represent that transition may omit it —
 *  the corresponding case is then skipped rather than failed. `seedCard` is
 *  optional too: it stores a published signed card for an already-seeded
 *  handle (§4.6) so the suite can assert getCard/list hint derivation; hosts
 *  with no card storage yet (this phase) omit it and the card cases skip. */
export function runHandleDirectoryContract(
  t: ContractTestPrimitives,
  make: () => Promise<{
    directory: HandleDirectory
    seed: (handle: string, record: HandleRecord) => Promise<void> | void
    seedTerminated?: (handle: string) => Promise<void> | void
    seedCard?: (handle: string, signedCard: AmtpSignedAgentCard) => Promise<void> | void
  }>
): void {
  t.describe('HandleDirectory contract', () => {
    t.test('resolve returns null for an unknown handle', async () => {
      const { directory } = await make()
      assert.equal(await directory.resolve('unknown-handle'), null)
    })

    t.test('resolve returns the seeded record exactly (recipientRef treated as opaque)', async () => {
      const { directory, seed } = await make()
      const record: HandleRecord = {
        recipientRef: 'opaque-token-123',
        inboundOpen: true,
        agentPublicKeyPem: 'agent-pub-key-pem',
      }
      await seed('alice', record)
      assert.deepEqual(await directory.resolve('alice'), record)
    })

    t.test('list() returns exactly the seeded handles, sorted ascending', async () => {
      const { directory, seed } = await make()
      await seed('charlie', { recipientRef: 'ref-c', inboundOpen: false, agentPublicKeyPem: null })
      await seed('alice', { recipientRef: 'ref-a', inboundOpen: false, agentPublicKeyPem: null })
      await seed('bob', { recipientRef: 'ref-b', inboundOpen: false, agentPublicKeyPem: null })
      assert.deepEqual(await directory.list(), [{ handle: 'alice' }, { handle: 'bob' }, { handle: 'charlie' }])
    })

    t.test('a terminated/unregistered handle is excluded from both resolve and list', async () => {
      const { directory, seed, seedTerminated } = await make()
      if (!seedTerminated) return // host can't represent this transition — skip
      await seed('dave', { recipientRef: 'ref-d', inboundOpen: true, agentPublicKeyPem: null })
      await seedTerminated('dave')
      assert.equal(await directory.resolve('dave'), null)
      assert.deepEqual(await directory.list(), [])
    })

    t.test('getCard returns null for an unknown or card-less handle', async () => {
      const { directory, seed } = await make()
      assert.equal(await directory.getCard('unknown'), null)
      await seed('alice', { recipientRef: 'r', inboundOpen: false, agentPublicKeyPem: null })
      assert.equal(await directory.getCard('alice'), null)
    })

    t.test('getCard returns the seeded signed card verbatim; list derives hints from it', async () => {
      const { directory, seed, seedCard } = await make()
      if (!seedCard) return // host has no card storage yet — skip
      await seed('alice', { recipientRef: 'r', inboundOpen: false, agentPublicKeyPem: 'k' })
      const signed = {
        v: 1 as const,
        instanceId: 'inst',
        handle: 'alice',
        card: { name: 'Alice', description: 'Support' },
        cardSig: 'sig-bytes',
      }
      await seedCard('alice', signed)
      assert.deepEqual(await directory.getCard('alice'), signed)
      assert.deepEqual(await directory.list(), [{ handle: 'alice', name: 'Alice', description: 'Support' }])
    })
  })
}
