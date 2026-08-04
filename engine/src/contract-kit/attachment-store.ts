import assert from 'node:assert/strict'
import type { AttachmentStore } from '../ports'
import type { ContractTestPrimitives } from './index'

export interface AttachmentBlob {
  bytes: Uint8Array
  contentType: string
  byteSize: number
}

/** §4.7 AttachmentStore contract. Both methods are read-only, so the factory
 *  returns seed hooks alongside the store under test — hosts implement them
 *  however they persist blobs / the storage-bytes aggregate. */
export function runAttachmentStoreContract(
  t: ContractTestPrimitives,
  make: () => Promise<{
    store: AttachmentStore
    seedBlob: (attachmentId: string, blob: AttachmentBlob) => Promise<void> | void
    seedStoredBytes: (bytes: number) => Promise<void> | void
  }>
): void {
  t.describe('AttachmentStore contract', () => {
    t.test('an unknown attachment id resolves null', async () => {
      const { store } = await make()
      assert.equal(await store.readOutboundBlob('unknown-id'), null)
    })

    t.test('a seeded blob resolves with its exact bytes/contentType/byteSize', async () => {
      const { store, seedBlob } = await make()
      const bytes = new TextEncoder().encode('hello attachment')
      await seedBlob('att-1', { bytes, contentType: 'text/plain', byteSize: bytes.length })
      const result = await store.readOutboundBlob('att-1')
      assert.ok(result)
      assert.deepEqual(result?.bytes, bytes)
      assert.equal(result?.contentType, 'text/plain')
      assert.equal(result?.byteSize, bytes.length)
    })

    t.test('byteSize is the recorded metadata value, independent of the actual bytes.length', async () => {
      const { store, seedBlob } = await make()
      const bytes = new TextEncoder().encode('hi')
      await seedBlob('att-2', { bytes, contentType: 'application/octet-stream', byteSize: 999 })
      const result = await store.readOutboundBlob('att-2')
      assert.equal(result?.byteSize, 999)
      assert.equal(result?.bytes.length, 2)
    })

    t.test('totalStoredBytes defaults to 0 when nothing has been seeded', async () => {
      const { store } = await make()
      assert.equal(await store.totalStoredBytes(), 0)
    })

    t.test('totalStoredBytes reflects the seeded aggregate', async () => {
      const { store, seedStoredBytes } = await make()
      await seedStoredBytes(4096)
      assert.equal(await store.totalStoredBytes(), 4096)
    })
  })
}
