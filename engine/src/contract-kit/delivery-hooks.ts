import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { AmtpAttachmentRef, AmtpEnvelope } from 'amtp-protocol'
import type { DeliveryHooks } from '../ports'
import type { ContractTestPrimitives } from './index'

export interface DeliveryHooksProbes {
  /** True iff onMessageReceived durably persisted this envelope (i.e. the
   *  call resolved rather than throwing). */
  hasMessage: (envelopeId: string) => Promise<boolean> | boolean
  /** True iff this attachment's blob is present in host-visible durable storage. */
  hasAttachmentBlob: (attachmentId: string) => Promise<boolean> | boolean
}

function fixtureEnvelope(): AmtpEnvelope {
  return {
    v: 1,
    id: randomUUID(),
    ts: Date.now(),
    from: 'amtp://peer-1/alice',
    to: 'amtp://local-instance/bob',
    content: 'hello',
  }
}

function fixtureAttachment(id: string): { ref: AmtpAttachmentRef; bytes: Uint8Array } {
  const bytes = new TextEncoder().encode(`bytes-for-${id}`)
  return {
    ref: { id, filename: `${id}.bin`, contentType: 'application/octet-stream', byteSize: bytes.length, sha256: 'x' },
    bytes,
  }
}

/** §4.10 DeliveryHooks rollback contract — the one normative host-visible
 *  behavior the engine cannot enforce itself: `onMessageReceived` throwing
 *  MUST leave no partial state (§4.10). `make` takes an optional
 *  `failAfterAttachments` so the suite can force a mid-persist failure, and
 *  returns both the hooks under test and probes for host-visible state
 *  (bound to the SAME backing store as those hooks). */
export function runDeliveryHooksContract(
  t: ContractTestPrimitives,
  make: (opts?: { failAfterAttachments?: number }) => Promise<{ hooks: DeliveryHooks; probes: DeliveryHooksProbes }>
): void {
  t.describe('DeliveryHooks contract — rollback', () => {
    t.test('onMessageReceived resolving persists the message and all attachment blobs', async () => {
      const { hooks, probes } = await make()
      const envelope = fixtureEnvelope()
      const attachments = [fixtureAttachment('att-1'), fixtureAttachment('att-2')]
      await hooks.onMessageReceived({
        envelope,
        peerInstanceId: 'peer-1',
        senderHandle: 'alice',
        recipientRef: 'agent-1',
        agentSigVerified: false,
        attachments,
      })
      assert.equal(await probes.hasMessage(envelope.id), true)
      assert.equal(await probes.hasAttachmentBlob('att-1'), true)
      assert.equal(await probes.hasAttachmentBlob('att-2'), true)
    })

    t.test('a text-only envelope (attachments: []) persists with no attachment blobs', async () => {
      const { hooks, probes } = await make()
      const envelope = fixtureEnvelope()
      await hooks.onMessageReceived({
        envelope,
        peerInstanceId: 'peer-1',
        senderHandle: 'alice',
        recipientRef: 'agent-1',
        agentSigVerified: false,
        attachments: [],
      })
      assert.equal(await probes.hasMessage(envelope.id), true)
    })

    t.test('onMessageReceived throwing mid-persist leaves NO host-visible partial state', async () => {
      const { hooks, probes } = await make({ failAfterAttachments: 1 })
      const envelope = fixtureEnvelope()
      const attachments = [fixtureAttachment('att-1'), fixtureAttachment('att-2'), fixtureAttachment('att-3')]
      await assert.rejects(() =>
        hooks.onMessageReceived({
          envelope,
          peerInstanceId: 'peer-1',
          senderHandle: 'alice',
          recipientRef: 'agent-1',
          agentSigVerified: false,
          attachments,
        })
      )
      assert.equal(await probes.hasMessage(envelope.id), false)
      assert.equal(await probes.hasAttachmentBlob('att-1'), false)
      assert.equal(await probes.hasAttachmentBlob('att-2'), false)
      assert.equal(await probes.hasAttachmentBlob('att-3'), false)
    })

    t.test('a throw on the FIRST attachment rolls back that attachment too (nothing partially kept)', async () => {
      const { hooks, probes } = await make({ failAfterAttachments: 0 })
      const envelope = fixtureEnvelope()
      const attachments = [fixtureAttachment('att-only')]
      await assert.rejects(() =>
        hooks.onMessageReceived({
          envelope,
          peerInstanceId: 'peer-1',
          senderHandle: 'alice',
          recipientRef: 'agent-1',
          agentSigVerified: false,
          attachments,
        })
      )
      assert.equal(await probes.hasMessage(envelope.id), false)
      assert.equal(await probes.hasAttachmentBlob('att-only'), false)
    })
  })
}
