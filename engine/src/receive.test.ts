import { describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import {
  canonicalAgentSigBytes,
  formatAmtpAddress,
  generateInstanceKeyPair,
  instanceIdFromPublicKeyPem,
  signEnvelope,
} from 'amtp-protocol'
import type { AmtpAttachmentRef, AmtpEnvelope } from 'amtp-protocol'
import type { AmtpEnginePorts } from './options'
import type { DeliveryHooks, ReceiveCaps } from './ports'
import { receiveEnvelope } from './receive'
import type { ReceiveEnvelopeRuntime } from './receive'
import { sha256Hex } from './sha256'
import {
  makeAttachmentStore,
  makeDeliveryHooks,
  makeFlakyPeerStore,
  makeHandleDirectory,
  makeIdentity,
  makeOutboxStore,
  makePeerStore,
  makePinStore,
  makeReceivePolicy,
  makeReplayLedger,
} from './testing/fakes'

// NOTE on 401: transport auth (verifyInboxPost) runs BEFORE receiveEnvelope is
// ever called (§5.4 step 1 — a host precondition); receiveEnvelope's own
// ReceiveResult type has no 401 variant. The 401/uniform-auth-failure cases
// are covered in verify.test.ts, not here.

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const NOW = 1_700_000_000_000

const ourKeys = generateInstanceKeyPair()
const ourInstanceId = instanceIdFromPublicKeyPem(ourKeys.publicKeyPem)
const peerKeys = generateInstanceKeyPair()
const peerInstanceId = instanceIdFromPublicKeyPem(peerKeys.publicKeyPem)
const agentKeys = generateInstanceKeyPair()

function envelope(overrides: Partial<AmtpEnvelope> = {}): AmtpEnvelope {
  return {
    v: 1,
    id: randomUUID(),
    ts: NOW,
    from: formatAmtpAddress(peerInstanceId, 'alice'),
    to: formatAmtpAddress(ourInstanceId, 'bob'),
    content: 'hello',
    ...overrides,
  }
}

function setup(
  opts: {
    inboundOpen?: boolean
    allow?: boolean
    deliveryImpl?: DeliveryHooks['onMessageReceived']
    caps?: ReceiveCaps
    attachmentsStored?: number
  } = {}
) {
  const peers = makePeerStore()
  peers.set(peerInstanceId, { baseUrl: 'https://peer.example', publicKeyPem: peerKeys.publicKeyPem, status: 'active' })
  const pins = makePinStore()
  const replays = makeReplayLedger()
  const handles = makeHandleDirectory()
  handles.set('bob', { recipientRef: 'agent-bob', inboundOpen: opts.inboundOpen ?? true, agentPublicKeyPem: null })
  const policy = makeReceivePolicy({ allow: opts.allow, caps: opts.caps })
  const attachments = makeAttachmentStore({ storedBytes: opts.attachmentsStored ?? 0 })
  const delivery = makeDeliveryHooks({ onMessageReceived: opts.deliveryImpl })
  const identity = makeIdentity(ourInstanceId, ourKeys.publicKeyPem, ourKeys.privateKeyPem)
  const outbox = makeOutboxStore()

  const ports: AmtpEnginePorts = { identity, peers, pins, replays, outbox, attachments, handles, policy, delivery }
  const runtime: ReceiveEnvelopeRuntime = { now: () => NOW }

  return { ports, peers, pins, replays, handles, policy, attachments, delivery, runtime }
}

async function receive(fx: ReturnType<typeof setup>, rawBody: string) {
  return receiveEnvelope(fx.ports, fx.runtime, { peerInstanceId, rawBody })
}

// ---------------------------------------------------------------------------
// §5.4 status-table coverage, in order
// ---------------------------------------------------------------------------

describe('receiveEnvelope — happy paths', () => {
  test('happy text → 200 accepted, delivered exactly once with attachments: []', async () => {
    const fx = setup()
    const env = envelope()
    const result = await receive(fx, JSON.stringify(env))
    expect(result).toEqual({ kind: 'accepted', httpStatus: 200, body: { accepted: true } })
    expect(fx.delivery.messageReceivedCalls).toHaveLength(1)
    expect(fx.delivery.messageReceivedCalls[0].attachments).toEqual([])
    expect(fx.delivery.messageReceivedCalls[0].recipientRef).toBe('agent-bob')
    expect(fx.delivery.messageReceivedCalls[0].senderHandle).toBe('alice')
    expect(fx.delivery.messageReceivedCalls[0].agentSigVerified).toBe(false)
  })

  test('happy attachments (pull override) → 200 accepted, blobs pulled + delivered', async () => {
    const fx = setup()
    const ref: AmtpAttachmentRef = {
      id: 'att-1',
      filename: 'a.txt',
      contentType: 'text/plain',
      byteSize: 5,
      sha256: 'unchecked-by-override',
    }
    const env = envelope({ attachments: [ref] })
    fx.runtime.overrides = {
      pullAttachment: async ({ ref }) => new TextEncoder().encode('hello').slice(0, ref.byteSize),
    }

    const result = await receive(fx, JSON.stringify(env))

    expect(result).toEqual({ kind: 'accepted', httpStatus: 200, body: { accepted: true } })
    expect(fx.delivery.messageReceivedCalls).toHaveLength(1)
    expect(fx.delivery.messageReceivedCalls[0].attachments).toHaveLength(1)
    expect(fx.delivery.messageReceivedCalls[0].attachments[0].ref).toEqual(ref)
    expect(fx.delivery.messageReceivedCalls[0].attachments[0].bytes).toEqual(new TextEncoder().encode('hello'))
  })

  test('closed mailbox + policy allows → 200 accepted (isReceiveAllowed exercised)', async () => {
    const fx = setup({ inboundOpen: false, allow: true })
    const result = await receive(fx, JSON.stringify(envelope()))
    expect(result.kind).toBe('accepted')
  })
})

describe('receiveEnvelope — step 2: parse + validate → 400 invalid_envelope', () => {
  test('malformed JSON body', async () => {
    const fx = setup()
    const result = await receive(fx, '{not json')
    expect(result).toEqual({
      kind: 'rejected',
      httpStatus: 400,
      reason: 'invalid_envelope',
      body: { error: 'Invalid envelope' },
    })
  })

  test('JSON that fails schema validation', async () => {
    const fx = setup()
    const result = await receive(fx, JSON.stringify({ v: 1, id: 'x' }))
    expect(result).toEqual({
      kind: 'rejected',
      httpStatus: 400,
      reason: 'invalid_envelope',
      body: { error: 'Invalid envelope' },
    })
  })
})

describe('receiveEnvelope — step 3: freshness → 400 stale_timestamp', () => {
  test('timestamp outside ±ENVELOPE_FRESHNESS_MS', async () => {
    const fx = setup()
    const env = envelope({ ts: NOW - 400_000 })
    const result = await receive(fx, JSON.stringify(env))
    expect(result).toEqual({
      kind: 'rejected',
      httpStatus: 400,
      reason: 'stale_timestamp',
      body: { error: 'Envelope timestamp out of range' },
    })
  })
})

describe('receiveEnvelope — step 4: from-integrity → 400 from_mismatch', () => {
  test('from address does not parse', async () => {
    const fx = setup()
    const env = envelope({ from: 'not-an-amtp-address' })
    const result = await receive(fx, JSON.stringify(env))
    expect(result).toEqual({
      kind: 'rejected',
      httpStatus: 400,
      reason: 'from_mismatch',
      body: { error: 'Envelope from-instance does not match verified peer' },
    })
  })

  test('from instanceId does not match the verified peer', async () => {
    const fx = setup()
    const env = envelope({ from: formatAmtpAddress('some-other-instance', 'alice') })
    const result = await receive(fx, JSON.stringify(env))
    expect(result).toEqual({
      kind: 'rejected',
      httpStatus: 400,
      reason: 'from_mismatch',
      body: { error: 'Envelope from-instance does not match verified peer' },
    })
  })
})

describe('receiveEnvelope — step 5: recipient resolution', () => {
  test('malformed recipient address → 400 invalid_recipient_address', async () => {
    const fx = setup()
    const env = envelope({ to: 'not-an-amtp-address' })
    const result = await receive(fx, JSON.stringify(env))
    expect(result).toEqual({
      kind: 'rejected',
      httpStatus: 400,
      reason: 'invalid_recipient_address',
      body: { error: 'Invalid recipient address' },
    })
  })

  test('recipient instanceId does not match ours → 404 recipient_not_found', async () => {
    const fx = setup()
    const env = envelope({ to: formatAmtpAddress('some-other-instance', 'bob') })
    const result = await receive(fx, JSON.stringify(env))
    expect(result).toEqual({
      kind: 'rejected',
      httpStatus: 404,
      reason: 'recipient_not_found',
      body: { error: 'Recipient not found' },
    })
  })

  test('unknown local handle → 404 recipient_not_found (uniform body with instance-mismatch case)', async () => {
    const fx = setup()
    const env = envelope({ to: formatAmtpAddress(ourInstanceId, 'nobody') })
    const result = await receive(fx, JSON.stringify(env))
    expect(result).toEqual({
      kind: 'rejected',
      httpStatus: 404,
      reason: 'recipient_not_found',
      body: { error: 'Recipient not found' },
    })
  })
})

describe('receiveEnvelope — step 6: policy gate → 403 not_allowed', () => {
  test('peer unknown at the gate (existence-only check)', async () => {
    const fx = setup()
    fx.peers.delete(peerInstanceId)
    const result = await receive(fx, JSON.stringify(envelope()))
    expect(result).toEqual({
      kind: 'rejected',
      httpStatus: 403,
      reason: 'not_allowed',
      body: { error: 'Sender not allowed' },
    })
  })

  test('closed mailbox, policy denies', async () => {
    const fx = setup({ inboundOpen: false, allow: false })
    const result = await receive(fx, JSON.stringify(envelope()))
    expect(result).toEqual({
      kind: 'rejected',
      httpStatus: 403,
      reason: 'not_allowed',
      body: { error: 'Sender not allowed' },
    })
  })
})

describe('receiveEnvelope — step 7: agent authorship', () => {
  test('agentKey present, no pin, peer vanishes before key-fetch → 403 not_allowed', async () => {
    const fx = setup()
    fx.ports.peers = makeFlakyPeerStore(
      { baseUrl: 'https://peer.example', publicKeyPem: peerKeys.publicKeyPem, status: 'active' },
      1 // step 6's gate check succeeds; step 7's re-check sees the peer gone
    )
    const env = envelope({ agentKey: agentKeys.publicKeyPem })
    const result = await receive(fx, JSON.stringify(env))
    expect(result).toEqual({
      kind: 'rejected',
      httpStatus: 403,
      reason: 'not_allowed',
      body: { error: 'Sender not allowed' },
    })
  })

  test('fail-closed 502 key_unavailable BEFORE dedup — override throws; no ledger record, no pin', async () => {
    const fx = setup()
    const env = envelope({ agentKey: agentKeys.publicKeyPem })
    fx.runtime.overrides = {
      fetchPeerAgentKey: async () => {
        throw new Error('network down')
      },
    }
    const result = await receive(fx, JSON.stringify(env))
    expect(result).toEqual({
      kind: 'retryable',
      httpStatus: 502,
      reason: 'key_unavailable',
      body: { error: 'Sender key unavailable; retry later' },
    })
    expect(fx.replays.seen.size).toBe(0)
    expect(fx.pins.pins.size).toBe(0)
  })

  test('default (non-overridden) key-fetch: network throw via injected runtime.fetch → 502 key_unavailable', async () => {
    const fx = setup()
    const env = envelope({ agentKey: agentKeys.publicKeyPem })
    fx.runtime.fetch = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    const result = await receive(fx, JSON.stringify(env))
    expect(result).toEqual({
      kind: 'retryable',
      httpStatus: 502,
      reason: 'key_unavailable',
      body: { error: 'Sender key unavailable; retry later' },
    })
    expect(fx.replays.seen.size).toBe(0)
    expect(fx.pins.pins.size).toBe(0)
  })

  test('first contact: key-fetch override succeeds → pin recorded, delivered', async () => {
    const fx = setup()
    const agentPub = agentKeys.publicKeyPem
    const env = envelope({ agentKey: agentPub })
    fx.runtime.overrides = {
      fetchPeerAgentKey: async () => ({ handle: 'alice', instanceId: peerInstanceId, identityPublicKey: agentPub }),
    }
    const result = await receive(fx, JSON.stringify(env))
    expect(result.kind).toBe('accepted')
    expect(fx.pins.pins.get(`${peerInstanceId}:alice`)).toBe(agentPub)
  })

  test('default (non-overridden) key-fetch: happy path via injected runtime.fetch', async () => {
    const fx = setup()
    const agentPub = agentKeys.publicKeyPem
    const env = envelope({ agentKey: agentPub })
    fx.runtime.fetch = (async (url: string) => {
      expect(String(url)).toContain('/amtp/agents/alice/key')
      return new Response(
        JSON.stringify({ handle: 'alice', instanceId: peerInstanceId, identityPublicKey: agentPub }),
        {
          status: 200,
        }
      )
    }) as unknown as typeof fetch
    const result = await receive(fx, JSON.stringify(env))
    expect(result.kind).toBe('accepted')
    expect(fx.pins.pins.get(`${peerInstanceId}:alice`)).toBe(agentPub)
  })

  test('pin exists and differs from envelope agentKey → 403 pin_mismatch', async () => {
    const fx = setup()
    fx.pins.pins.set(`${peerInstanceId}:alice`, 'pinned-key-A')
    const env = envelope({ agentKey: 'different-key-B' })
    const result = await receive(fx, JSON.stringify(env))
    expect(result).toEqual({
      kind: 'rejected',
      httpStatus: 403,
      reason: 'pin_mismatch',
      body: { error: 'Sender key mismatch' },
    })
  })

  test('agentSig verifies against the pin → agentSigVerified true, delivered', async () => {
    const fx = setup()
    const agentPub = agentKeys.publicKeyPem
    fx.pins.pins.set(`${peerInstanceId}:alice`, agentPub)
    const base = envelope({ agentKey: agentPub })
    const sigBytes = canonicalAgentSigBytes({
      v: 1,
      id: base.id,
      from: base.from,
      to: base.to,
      subject: base.subject,
      content: base.content,
      attachments: [],
    })
    const agentSig = signEnvelope(agentKeys.privateKeyPem, sigBytes)
    const env = { ...base, agentSig }
    const result = await receive(fx, JSON.stringify(env))
    expect(result.kind).toBe('accepted')
    expect(fx.delivery.messageReceivedCalls[0].agentSigVerified).toBe(true)
  })

  test('agentSig fails to verify → advisory only, agentSigVerified false, still delivered', async () => {
    const fx = setup()
    const agentPub = agentKeys.publicKeyPem
    fx.pins.pins.set(`${peerInstanceId}:alice`, agentPub)
    const env = envelope({ agentKey: agentPub, agentSig: Buffer.from('not-a-real-signature').toString('base64') })
    const result = await receive(fx, JSON.stringify(env))
    expect(result.kind).toBe('accepted')
    expect(fx.delivery.messageReceivedCalls[0].agentSigVerified).toBe(false)
  })
})

describe('receiveEnvelope — step 8: replay dedup → 200 duplicate', () => {
  test('same envelope id delivered twice → second is a no-op duplicate ack', async () => {
    const fx = setup()
    const raw = JSON.stringify(envelope())
    const first = await receive(fx, raw)
    expect(first.kind).toBe('accepted')
    const second = await receive(fx, raw)
    expect(second).toEqual({ kind: 'accepted', httpStatus: 200, body: { accepted: true, duplicate: true } })
    expect(fx.delivery.messageReceivedCalls).toHaveLength(1)
  })
})

describe('receiveEnvelope — step 9: attachment failures (each code, unrecord asserted)', () => {
  test('413 attachment_too_large (default pull, per-item cap, no network call needed)', async () => {
    const fx = setup({ caps: { maxAttachmentBytes: 10, maxTotalStorageBytes: Number.POSITIVE_INFINITY } })
    const ref: AmtpAttachmentRef = {
      id: 'att-1',
      filename: 'big.bin',
      contentType: 'application/octet-stream',
      byteSize: 999,
      sha256: 'x',
    }
    const env = envelope({ attachments: [ref] })
    const result = await receive(fx, JSON.stringify(env))
    expect(result).toEqual({
      kind: 'rejected',
      httpStatus: 413,
      reason: 'attachment_too_large',
      body: { error: 'Attachment too large' },
    })
    expect(fx.replays.seen.size).toBe(0)
    expect(fx.delivery.messageReceivedCalls).toHaveLength(0)
  })

  test('422 attachment_verification_failed — pull override throws ATTACHMENT_HASH_MISMATCH', async () => {
    const fx = setup()
    const ref: AmtpAttachmentRef = {
      id: 'att-1',
      filename: 'f.txt',
      contentType: 'text/plain',
      byteSize: 5,
      sha256: 'aa',
    }
    const env = envelope({ attachments: [ref] })
    fx.runtime.overrides = {
      pullAttachment: async () => {
        throw new Error('ATTACHMENT_HASH_MISMATCH')
      },
    }
    const result = await receive(fx, JSON.stringify(env))
    expect(result).toEqual({
      kind: 'rejected',
      httpStatus: 422,
      reason: 'attachment_verification_failed',
      body: { error: 'Attachment verification failed' },
    })
    expect(fx.replays.seen.size).toBe(0)
  })

  test('422 attachment_verification_failed — pull override throws ATTACHMENT_SIZE_MISMATCH', async () => {
    const fx = setup()
    const ref: AmtpAttachmentRef = {
      id: 'att-1',
      filename: 'f.txt',
      contentType: 'text/plain',
      byteSize: 5,
      sha256: 'aa',
    }
    const env = envelope({ attachments: [ref] })
    fx.runtime.overrides = {
      pullAttachment: async () => {
        throw new Error('ATTACHMENT_SIZE_MISMATCH')
      },
    }
    const result = await receive(fx, JSON.stringify(env))
    expect(result).toEqual({
      kind: 'rejected',
      httpStatus: 422,
      reason: 'attachment_verification_failed',
      body: { error: 'Attachment verification failed' },
    })
    expect(fx.replays.seen.size).toBe(0)
  })

  test('507 quota_exceeded — aggregate cap pre-check, before any network call', async () => {
    const fx = setup({
      caps: { maxAttachmentBytes: Number.POSITIVE_INFINITY, maxTotalStorageBytes: 100 },
      attachmentsStored: 90,
    })
    const ref: AmtpAttachmentRef = {
      id: 'att-1',
      filename: 'f.bin',
      contentType: 'application/octet-stream',
      byteSize: 20,
      sha256: 'aa',
    }
    const env = envelope({ attachments: [ref] })
    const result = await receive(fx, JSON.stringify(env))
    expect(result).toEqual({
      kind: 'retryable',
      httpStatus: 507,
      reason: 'quota_exceeded',
      body: { error: 'Inbox storage quota exceeded' },
    })
    expect(fx.replays.seen.size).toBe(0)
  })

  test('502 pull_failed — peer vanishes before the pull step (peers.getPeer null at 9.1)', async () => {
    const fx = setup()
    fx.ports.peers = makeFlakyPeerStore(
      { baseUrl: 'https://peer.example', publicKeyPem: peerKeys.publicKeyPem, status: 'active' },
      1
    )
    const ref: AmtpAttachmentRef = {
      id: 'att-1',
      filename: 'f.bin',
      contentType: 'application/octet-stream',
      byteSize: 5,
      sha256: 'aa',
    }
    const env = envelope({ attachments: [ref] })
    const result = await receive(fx, JSON.stringify(env))
    expect(result).toEqual({
      kind: 'retryable',
      httpStatus: 502,
      reason: 'pull_failed',
      body: { error: 'Attachment pull failed' },
    })
    expect(fx.replays.seen.size).toBe(0)
  })

  test('502 pull_failed — pull override throws an unrecognized (network/abort) error', async () => {
    const fx = setup()
    const ref: AmtpAttachmentRef = {
      id: 'att-1',
      filename: 'f.bin',
      contentType: 'application/octet-stream',
      byteSize: 5,
      sha256: 'aa',
    }
    const env = envelope({ attachments: [ref] })
    fx.runtime.overrides = {
      pullAttachment: async () => {
        throw new Error('some network blip')
      },
    }
    const result = await receive(fx, JSON.stringify(env))
    expect(result).toEqual({
      kind: 'retryable',
      httpStatus: 502,
      reason: 'pull_failed',
      body: { error: 'Attachment pull failed' },
    })
    expect(fx.replays.seen.size).toBe(0)
  })

  test('default (non-overridden) pull: happy path via injected runtime.fetch verifies size + sha256', async () => {
    const fx = setup()
    const bytes = new TextEncoder().encode('hello')
    const ref: AmtpAttachmentRef = {
      id: 'att-1',
      filename: 'f.txt',
      contentType: 'text/plain',
      byteSize: bytes.length,
      sha256: sha256Hex(bytes),
    }
    const env = envelope({ attachments: [ref] })
    fx.runtime.fetch = (async (_url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>
      expect(headers['x-amtp-instance']).toBe(ourInstanceId)
      expect(headers['x-amtp-signature']).toBeTruthy()
      expect(headers['x-amtp-timestamp']).toBeTruthy()
      return new Response(bytes, { status: 200 })
    }) as unknown as typeof fetch

    const result = await receive(fx, JSON.stringify(env))
    expect(result.kind).toBe('accepted')
    expect(fx.delivery.messageReceivedCalls[0].attachments[0].bytes).toEqual(bytes)
  })

  test('default pull: server returns bytes that fail hash verification → 422', async () => {
    const fx = setup()
    const ref: AmtpAttachmentRef = {
      id: 'att-1',
      filename: 'f.txt',
      contentType: 'text/plain',
      byteSize: 5,
      sha256: '0'.repeat(64),
    }
    const env = envelope({ attachments: [ref] })
    fx.runtime.fetch = (async () =>
      new Response(new TextEncoder().encode('wrong'), { status: 200 })) as unknown as typeof fetch

    const result = await receive(fx, JSON.stringify(env))
    expect(result).toEqual({
      kind: 'rejected',
      httpStatus: 422,
      reason: 'attachment_verification_failed',
      body: { error: 'Attachment verification failed' },
    })
    expect(fx.replays.seen.size).toBe(0)
  })

  test('default pull: non-2xx response → 502 pull_failed', async () => {
    const fx = setup()
    const ref: AmtpAttachmentRef = {
      id: 'att-1',
      filename: 'f.txt',
      contentType: 'text/plain',
      byteSize: 5,
      sha256: 'aa',
    }
    const env = envelope({ attachments: [ref] })
    fx.runtime.fetch = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch

    const result = await receive(fx, JSON.stringify(env))
    expect(result).toEqual({
      kind: 'retryable',
      httpStatus: 502,
      reason: 'pull_failed',
      body: { error: 'Attachment pull failed' },
    })
    expect(fx.replays.seen.size).toBe(0)
  })
})

describe('receiveEnvelope — step 9.2/9.3: caps snapshot + sequential pull order', () => {
  test('single receive-caps snapshot: getReceiveCaps called exactly once; a hypothetical per-pull re-read would flip the outcome', async () => {
    const fx = setup()
    const bytes1 = new TextEncoder().encode('AAAAA')
    const bytes2 = new TextEncoder().encode('BBBBB')
    const ref1: AmtpAttachmentRef = {
      id: 'att-1',
      filename: 'a.txt',
      contentType: 'text/plain',
      byteSize: 5,
      sha256: sha256Hex(bytes1),
    }
    const ref2: AmtpAttachmentRef = {
      id: 'att-2',
      filename: 'b.txt',
      contentType: 'text/plain',
      byteSize: 5,
      sha256: sha256Hex(bytes2),
    }
    const env = envelope({ attachments: [ref1, ref2] })

    // First call returns generous caps that admit both 5-byte attachments.
    // Any hypothetical second call returns caps too small to admit them —
    // if the engine ever re-read getReceiveCaps() per-pull instead of
    // threading a single snapshot, ref2's pull would throw ATTACHMENT_TOO_LARGE
    // and this test would flip from accepted to rejected.
    const generousCaps: ReceiveCaps = { maxAttachmentBytes: 1000, maxTotalStorageBytes: 1000 }
    const tinyCaps: ReceiveCaps = { maxAttachmentBytes: 1, maxTotalStorageBytes: 1000 }
    let capsCalls = 0
    fx.ports.policy = {
      async isReceiveAllowed() {
        return true
      },
      async getReceiveCaps() {
        capsCalls += 1
        return capsCalls === 1 ? generousCaps : tinyCaps
      },
    }
    fx.runtime.fetch = (async (url: string) => {
      if (String(url).includes('att-1')) return new Response(bytes1, { status: 200 })
      return new Response(bytes2, { status: 200 })
    }) as unknown as typeof fetch

    const result = await receive(fx, JSON.stringify(env))

    expect(result.kind).toBe('accepted')
    expect(capsCalls).toBe(1)
    expect(fx.delivery.messageReceivedCalls).toHaveLength(1)
    expect(fx.delivery.messageReceivedCalls[0].attachments).toHaveLength(2)
    expect(fx.delivery.messageReceivedCalls[0].attachments[0].bytes).toEqual(bytes1)
    expect(fx.delivery.messageReceivedCalls[0].attachments[1].bytes).toEqual(bytes2)
  })

  test('attachments are pulled sequentially, in envelope order, never overlapping', async () => {
    const fx = setup()
    const ref1: AmtpAttachmentRef = {
      id: 'att-1',
      filename: 'a.txt',
      contentType: 'text/plain',
      byteSize: 5,
      sha256: 'x',
    }
    const ref2: AmtpAttachmentRef = {
      id: 'att-2',
      filename: 'b.txt',
      contentType: 'text/plain',
      byteSize: 5,
      sha256: 'y',
    }
    const ref3: AmtpAttachmentRef = {
      id: 'att-3',
      filename: 'c.txt',
      contentType: 'text/plain',
      byteSize: 5,
      sha256: 'z',
    }
    const env = envelope({ attachments: [ref1, ref2, ref3] })

    const pulledOrder: string[] = []
    let inFlight = 0
    let maxInFlight = 0
    fx.runtime.overrides = {
      pullAttachment: async ({ ref }) => {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        pulledOrder.push(ref.id)
        // yield a tick so a future Promise.all-style regression (which would
        // start the next pull before this one resolves) shows up as overlap.
        await new Promise((resolve) => setTimeout(resolve, 0))
        inFlight -= 1
        return new Uint8Array(ref.byteSize)
      },
    }

    const result = await receive(fx, JSON.stringify(env))

    expect(result.kind).toBe('accepted')
    expect(pulledOrder).toEqual((env.attachments ?? []).map((a) => a.id))
    expect(env.attachments?.length).toBeGreaterThan(1)
    expect(maxInFlight).toBe(1)
  })
})

describe('receiveEnvelope — hook-throw: unrecord + correct body, text vs attachment path', () => {
  test('text envelope: onMessageReceived throws → 502 delivery_failed, body "Delivery failed"', async () => {
    const fx = setup({
      deliveryImpl: async () => {
        throw new Error('db down')
      },
    })
    const result = await receive(fx, JSON.stringify(envelope()))
    expect(result).toEqual({
      kind: 'retryable',
      httpStatus: 502,
      reason: 'delivery_failed',
      body: { error: 'Delivery failed' },
    })
    expect(fx.replays.seen.size).toBe(0)
  })

  test('attachment envelope: onMessageReceived throws unrecognized message → 502 delivery_failed, body "Attachment pull failed" (catch-all quirk)', async () => {
    const fx = setup({
      deliveryImpl: async () => {
        throw new Error('boom')
      },
    })
    const ref: AmtpAttachmentRef = {
      id: 'att-1',
      filename: 'f.bin',
      contentType: 'application/octet-stream',
      byteSize: 5,
      sha256: 'aa',
    }
    const env = envelope({ attachments: [ref] })
    fx.runtime.overrides = { pullAttachment: async ({ ref }) => new Uint8Array(ref.byteSize) }

    const result = await receive(fx, JSON.stringify(env))
    expect(result).toEqual({
      kind: 'retryable',
      httpStatus: 502,
      reason: 'delivery_failed',
      body: { error: 'Attachment pull failed' },
    })
    expect(fx.replays.seen.size).toBe(0)
  })

  test('attachment envelope: onMessageReceived throws a recognized §4.4 code (ATTACHMENT_TOO_LARGE re-check) → 413', async () => {
    const fx = setup({
      deliveryImpl: async () => {
        throw new Error('ATTACHMENT_TOO_LARGE')
      },
    })
    const ref: AmtpAttachmentRef = {
      id: 'att-1',
      filename: 'f.bin',
      contentType: 'application/octet-stream',
      byteSize: 5,
      sha256: 'aa',
    }
    const env = envelope({ attachments: [ref] })
    fx.runtime.overrides = { pullAttachment: async ({ ref }) => new Uint8Array(ref.byteSize) }

    const result = await receive(fx, JSON.stringify(env))
    expect(result).toEqual({
      kind: 'rejected',
      httpStatus: 413,
      reason: 'attachment_too_large',
      body: { error: 'Attachment too large' },
    })
    expect(fx.replays.seen.size).toBe(0)
  })
})
