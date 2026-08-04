import { describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { generateInstanceKeyPair, instanceIdFromPublicKeyPem, verifyEnvelope } from 'amtp-protocol'
import type { AmtpEnvelope } from 'amtp-protocol'
import { OUTBOX_MAX_ATTEMPTS } from './options'
import type { AmtpEnginePorts } from './options'
import { drainOutboxOnce, enqueueSend } from './outbox'
import type { DrainOutboxRuntime, EnqueueSendRuntime } from './outbox'
import type { DeliveryHooks, OutboxEntry } from './ports'
import {
  makeAttachmentStore,
  makeDeliveryHooks,
  makeHandleDirectory,
  makeIdentity,
  makeOutboxStore,
  makePeerStore,
  makePinStore,
  makeReceivePolicy,
  makeReplayLedger,
} from './testing/fakes'

// Every delivery attempt signs the re-stamped envelope with the identity's
// PRIVATE key BEFORE the fetch call (§5.10) — a placeholder non-PEM string
// throws inside signEnvelope itself, which would masquerade as a "network
// error" branch in these tests. Use a real generated keypair by default so
// only the intentionally-exercised failure mode (fetch response/throw) is
// under test.
const DEFAULT_IDENTITY_KEYS = generateInstanceKeyPair()

function makePorts(overrides: Partial<AmtpEnginePorts> = {}): AmtpEnginePorts {
  return {
    identity:
      overrides.identity ??
      makeIdentity('self-instance', DEFAULT_IDENTITY_KEYS.publicKeyPem, DEFAULT_IDENTITY_KEYS.privateKeyPem),
    peers: overrides.peers ?? makePeerStore(),
    pins: overrides.pins ?? makePinStore(),
    replays: overrides.replays ?? makeReplayLedger(),
    outbox: overrides.outbox ?? makeOutboxStore(),
    attachments: overrides.attachments ?? makeAttachmentStore(),
    handles: overrides.handles ?? makeHandleDirectory(),
    policy: overrides.policy ?? makeReceivePolicy(),
    delivery: overrides.delivery ?? makeDeliveryHooks(),
  }
}

const NOW = 1_700_000_000_000

function drainRuntime(overrides: Partial<DrainOutboxRuntime> = {}): DrainOutboxRuntime {
  return {
    now: () => NOW,
    logger: () => {},
    maxAttempts: OUTBOX_MAX_ATTEMPTS,
    claimStaleMs: 300_000,
    deliveryTimeoutMs: 10_000,
    attachmentDeliveryTimeoutMs: 60_000,
    ...overrides,
  }
}

function makeRow(overrides: Partial<OutboxEntry> = {}): OutboxEntry {
  const envelope: AmtpEnvelope = {
    v: 1,
    id: randomUUID(),
    ts: NOW - 500_000,
    from: 'amtp://local-instance/alice',
    to: 'amtp://peer-1/bob',
    subject: 'hi',
    content: 'hello federation',
  }
  return {
    id: randomUUID(),
    peerInstanceId: 'peer-1',
    toAddress: 'amtp://peer-1/bob',
    envelope,
    attempts: 0,
    claimToken: 'token-1',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// §5.10 drainOutboxOnce
// ---------------------------------------------------------------------------

describe('drainOutboxOnce — delivery', () => {
  test('delivers a pending row: POSTs the re-stamped, signed envelope and marks delivered (real keypair verification)', async () => {
    const keys = generateInstanceKeyPair()
    const instanceId = instanceIdFromPublicKeyPem(keys.publicKeyPem)
    const peers = makePeerStore()
    peers.set('peer-1', { baseUrl: 'https://peer.example/api', publicKeyPem: 'unused-by-drain', status: 'active' })
    const row = makeRow()
    const outbox = makeOutboxStore([row])
    const ports = makePorts({
      identity: makeIdentity(instanceId, keys.publicKeyPem, keys.privateKeyPem),
      peers,
      outbox,
    })

    let capturedUrl: string | undefined
    let capturedInit: RequestInit | undefined
    const fetchImpl = (async (url: string, init: RequestInit) => {
      capturedUrl = url
      capturedInit = init
      return new Response(JSON.stringify({ accepted: true }), { status: 200 })
    }) as unknown as typeof fetch

    const result = await drainOutboxOnce(ports, drainRuntime({ fetch: fetchImpl }), 20)

    expect(result).toEqual({ delivered: 1, failedTerminal: 0, retried: 0 })
    expect(capturedUrl).toBe('https://peer.example/api/amtp/inbox')
    expect(capturedInit?.method).toBe('POST')

    const headers = capturedInit!.headers as Record<string, string>
    expect(headers['content-type']).toBe('application/json')
    expect(headers['x-amtp-instance']).toBe(instanceId)

    // Cryptographically verify the signature over the EXACT posted bytes.
    const postedBody = capturedInit!.body as string
    expect(verifyEnvelope(keys.publicKeyPem, new TextEncoder().encode(postedBody), headers['x-amtp-signature'])).toBe(
      true
    )

    const parsed = JSON.parse(postedBody)
    // id unchanged (receiver dedup nonce); ts re-stamped to the drain clock.
    expect(parsed.id).toBe(row.envelope.id)
    expect(parsed.to).toBe(row.envelope.to)
    expect(parsed.from).toBe(row.envelope.from)
    expect(parsed.content).toBe(row.envelope.content)
    expect(parsed.ts).toBe(NOW)
    expect(parsed.ts).not.toBe(row.envelope.ts)

    expect(outbox.markDeliveredCalls).toEqual([{ id: row.id, claimToken: 'token-1' }])
  })

  test('non-retryable status (403) dead-letters immediately (no retry), bounce fires regardless of marker booleans', async () => {
    const peers = makePeerStore()
    peers.set('peer-1', { baseUrl: 'https://peer.example', publicKeyPem: 'x', status: 'active' })
    const row = makeRow()
    // Markers return false (simulating a stale-reclaim race) — the engine must not care.
    const outbox = makeOutboxStore([row], { returnFalseFromMarkers: true })
    const delivery = makeDeliveryHooks()
    const ports = makePorts({ peers, outbox, delivery })

    const fetchImpl = (async () => new Response('forbidden', { status: 403 })) as unknown as typeof fetch
    const result = await drainOutboxOnce(ports, drainRuntime({ fetch: fetchImpl }), 20)

    expect(result).toEqual({ delivered: 0, failedTerminal: 1, retried: 0 })
    expect(outbox.markFailedTerminalCalls).toEqual([
      { id: row.id, claimToken: 'token-1', error: 'delivery failed: HTTP 403' },
    ])
    expect(outbox.markRetryCalls).toHaveLength(0)
    expect(delivery.deliveryFailedCalls).toEqual([
      {
        outboxId: row.id,
        envelopeId: row.envelope.id,
        toAddress: row.toAddress,
        fromAddress: row.envelope.from,
        senderHandle: 'alice',
        subject: 'hi',
        reason: 'delivery failed: HTTP 403',
        attempts: 1,
      },
    ])
  })

  test('retryable status (500) below max attempts schedules a retry (markRetry, not dead-lettered)', async () => {
    const peers = makePeerStore()
    peers.set('peer-1', { baseUrl: 'https://peer.example', publicKeyPem: 'x', status: 'active' })
    const row = makeRow({ attempts: 3 })
    const outbox = makeOutboxStore([row])
    const delivery = makeDeliveryHooks()
    const ports = makePorts({ peers, outbox, delivery })

    const fetchImpl = (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch
    const result = await drainOutboxOnce(ports, drainRuntime({ fetch: fetchImpl }), 20)

    expect(result).toEqual({ delivered: 0, failedTerminal: 0, retried: 1 })
    expect(outbox.markRetryCalls).toEqual([{ id: row.id, claimToken: 'token-1', error: 'delivery failed: HTTP 500' }])
    expect(outbox.markFailedTerminalCalls).toHaveLength(0)
    expect(delivery.deliveryFailedCalls).toHaveLength(0)
  })

  test('retryable status (500) AT max attempts dead-letters with the "max delivery attempts exceeded" prefix', async () => {
    const peers = makePeerStore()
    peers.set('peer-1', { baseUrl: 'https://peer.example', publicKeyPem: 'x', status: 'active' })
    const row = makeRow({ attempts: OUTBOX_MAX_ATTEMPTS - 1 })
    const outbox = makeOutboxStore([row])
    const delivery = makeDeliveryHooks()
    const ports = makePorts({ peers, outbox, delivery })

    const fetchImpl = (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch
    const result = await drainOutboxOnce(ports, drainRuntime({ fetch: fetchImpl }), 20)

    expect(result).toEqual({ delivered: 0, failedTerminal: 1, retried: 0 })
    expect(outbox.markFailedTerminalCalls).toEqual([
      {
        id: row.id,
        claimToken: 'token-1',
        error: 'max delivery attempts exceeded: delivery failed: HTTP 500',
      },
    ])
    expect(delivery.deliveryFailedCalls[0].reason).toBe('max delivery attempts exceeded: delivery failed: HTTP 500')
    expect(delivery.deliveryFailedCalls[0].attempts).toBe(OUTBOX_MAX_ATTEMPTS)
  })

  test('network error (fetch throws) below max attempts schedules a retry with the error message', async () => {
    const peers = makePeerStore()
    peers.set('peer-1', { baseUrl: 'https://peer.example', publicKeyPem: 'x', status: 'active' })
    const row = makeRow()
    const outbox = makeOutboxStore([row])
    const ports = makePorts({ peers, outbox })

    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    const result = await drainOutboxOnce(ports, drainRuntime({ fetch: fetchImpl }), 20)

    expect(result).toEqual({ delivered: 0, failedTerminal: 0, retried: 1 })
    expect(outbox.markRetryCalls).toEqual([{ id: row.id, claimToken: 'token-1', error: 'ECONNREFUSED' }])
  })

  test('network error AT max attempts dead-letters with the "max delivery attempts exceeded" prefix', async () => {
    const peers = makePeerStore()
    peers.set('peer-1', { baseUrl: 'https://peer.example', publicKeyPem: 'x', status: 'active' })
    const row = makeRow({ attempts: OUTBOX_MAX_ATTEMPTS - 1 })
    const outbox = makeOutboxStore([row])
    const ports = makePorts({ peers, outbox })

    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    const result = await drainOutboxOnce(ports, drainRuntime({ fetch: fetchImpl }), 20)

    expect(result).toEqual({ delivered: 0, failedTerminal: 1, retried: 0 })
    expect(outbox.markFailedTerminalCalls).toEqual([
      { id: row.id, claimToken: 'token-1', error: 'max delivery attempts exceeded: ECONNREFUSED' },
    ])
  })

  test('batch isolation: one row throwing never aborts delivery of the other rows in the batch', async () => {
    const peers = makePeerStore()
    peers.set('peer-1', { baseUrl: 'https://bad.example', publicKeyPem: 'x', status: 'active' })
    peers.set('peer-2', { baseUrl: 'https://good.example', publicKeyPem: 'x', status: 'active' })
    const badRow = makeRow({ peerInstanceId: 'peer-1', claimToken: 'tok-a' })
    const goodRow = makeRow({ peerInstanceId: 'peer-2', claimToken: 'tok-b' })
    const outbox = makeOutboxStore([badRow, goodRow])
    const ports = makePorts({ peers, outbox })

    const fetchImpl = (async (url: string) => {
      if (String(url).includes('bad.example')) throw new Error('ECONNREFUSED bad peer')
      return new Response(JSON.stringify({ accepted: true }), { status: 200 })
    }) as unknown as typeof fetch

    const result = await drainOutboxOnce(ports, drainRuntime({ fetch: fetchImpl }), 20)

    expect(result).toEqual({ delivered: 1, failedTerminal: 0, retried: 1 })
    expect(outbox.markRetryCalls).toEqual([{ id: badRow.id, claimToken: 'tok-a', error: 'ECONNREFUSED bad peer' }])
    expect(outbox.markDeliveredCalls).toEqual([{ id: goodRow.id, claimToken: 'tok-b' }])
  })

  test('peer not active: retried UNCONDITIONALLY, even past maxAttempts (retry-forever quirk, §9); fetch is never called', async () => {
    const peers = makePeerStore()
    peers.set('peer-1', { baseUrl: 'https://peer.example', publicKeyPem: 'x', status: 'disabled' })
    const row = makeRow({ attempts: OUTBOX_MAX_ATTEMPTS + 5 })
    const outbox = makeOutboxStore([row])
    const delivery = makeDeliveryHooks()
    const ports = makePorts({ peers, outbox, delivery })

    const fetchImpl = (async () => {
      throw new Error('fetch must never be called for an inactive peer')
    }) as unknown as typeof fetch

    const result = await drainOutboxOnce(ports, drainRuntime({ fetch: fetchImpl }), 20)

    expect(result).toEqual({ delivered: 0, failedTerminal: 0, retried: 1 })
    expect(outbox.markRetryCalls).toEqual([{ id: row.id, claimToken: 'token-1', error: 'peer not active: disabled' }])
    expect(outbox.markFailedTerminalCalls).toHaveLength(0)
    expect(delivery.deliveryFailedCalls).toHaveLength(0)
  })

  test('peer missing entirely: retried with "peer not found: <id>", never dead-lettered', async () => {
    const row = makeRow({ peerInstanceId: 'ghost-peer' })
    const outbox = makeOutboxStore([row])
    const ports = makePorts({ outbox }) // empty PeerStore — getPeer resolves null

    const result = await drainOutboxOnce(ports, drainRuntime(), 20)

    expect(result).toEqual({ delivered: 0, failedTerminal: 0, retried: 1 })
    expect(outbox.markRetryCalls).toEqual([{ id: row.id, claimToken: 'token-1', error: 'peer not found: ghost-peer' }])
  })

  // The fetch fake below never settles on its own — it only rejects once the
  // request's AbortSignal actually fires. This pins TIMEOUT SELECTION: which
  // of runtime.deliveryTimeoutMs / attachmentDeliveryTimeoutMs the engine
  // passed to AbortSignal.timeout(...) for this envelope. Swapping the two
  // constants at the call site would flip which of the two tests below
  // observes an abort, so — unlike the old assertion (delivered:1 only) —
  // these fail if the selection is inverted.
  function hangingUntilAbortedFetch(): typeof fetch {
    return (async (_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))
      })
    }) as unknown as typeof fetch
  }

  test('text envelope: the SHORT deliveryTimeoutMs is selected — signal aborts (~5ms) and is classified as a timeout retry', async () => {
    const peers = makePeerStore()
    peers.set('peer-1', { baseUrl: 'https://peer.example', publicKeyPem: 'x', status: 'active' })
    const row = makeRow() // no attachments
    const outbox = makeOutboxStore([row])
    const ports = makePorts({ peers, outbox })

    const result = await drainOutboxOnce(
      ports,
      drainRuntime({ fetch: hangingUntilAbortedFetch(), deliveryTimeoutMs: 5, attachmentDeliveryTimeoutMs: 10_000 }),
      20
    )

    // AbortSignal.timeout's DOMException reason has a fixed, engine-independent
    // message — pinning it (rather than just the counters) proves the abort
    // fired from OUR 5ms signal, not from some other failure mode.
    expect(result).toEqual({ delivered: 0, failedTerminal: 0, retried: 1 })
    expect(outbox.markRetryCalls).toEqual([{ id: row.id, claimToken: 'token-1', error: 'The operation timed out.' }])
  })

  test('attachment envelope: the LONG attachmentDeliveryTimeoutMs is selected — the same hanging fetch is still pending well past the short timeout', async () => {
    const peers = makePeerStore()
    peers.set('peer-1', { baseUrl: 'https://peer.example', publicKeyPem: 'x', status: 'active' })
    const row = makeRow({
      envelope: {
        v: 1,
        id: randomUUID(),
        ts: NOW,
        from: 'amtp://local-instance/alice',
        to: 'amtp://peer-1/bob',
        content: 'has attachment',
        attachments: [{ id: 'att-1', filename: 'f.txt', contentType: 'text/plain', byteSize: 5, sha256: 'x' }],
      },
    })
    const outbox = makeOutboxStore([row])
    const ports = makePorts({ peers, outbox })

    const drainPromise = drainOutboxOnce(
      ports,
      drainRuntime({ fetch: hangingUntilAbortedFetch(), deliveryTimeoutMs: 5, attachmentDeliveryTimeoutMs: 300 }),
      20
    )

    const STILL_PENDING = Symbol('still-pending')
    const raceResult = await Promise.race([
      drainPromise,
      new Promise((resolve) => setTimeout(() => resolve(STILL_PENDING), 50)),
    ])

    // If the SHORT (5ms) timeout had been applied here too, the drain would
    // already have resolved (as a timeout retry) well before this 50ms mark.
    expect(raceResult).toBe(STILL_PENDING)
    expect(outbox.markRetryCalls).toHaveLength(0)

    // Let the 300ms attachment timeout actually fire so it classifies too,
    // rather than leaving a dangling unresolved drain past the test.
    const finalResult = await drainPromise
    expect(finalResult).toEqual({ delivered: 0, failedTerminal: 0, retried: 1 })
  })

  test('onDeliveryFailed hook throwing does not un-mark the terminal state, abort the drain, or block a sibling delivery in the same batch', async () => {
    const peers = makePeerStore()
    peers.set('peer-1', { baseUrl: 'https://bad.example', publicKeyPem: 'x', status: 'active' })
    peers.set('peer-2', { baseUrl: 'https://good.example', publicKeyPem: 'x', status: 'active' })
    const failRow = makeRow({ peerInstanceId: 'peer-1', claimToken: 'tok-a' })
    const goodRow = makeRow({ peerInstanceId: 'peer-2', claimToken: 'tok-b' })
    const outbox = makeOutboxStore([failRow, goodRow])
    const delivery: DeliveryHooks = {
      async onMessageReceived() {
        throw new Error('not used by outbox tests')
      },
      async onDeliveryFailed() {
        throw new Error('bounce webhook exploded')
      },
    }
    const ports = makePorts({ peers, outbox, delivery })

    const fetchImpl = (async (url: string) => {
      if (String(url).includes('bad.example')) return new Response('forbidden', { status: 403 })
      return new Response(JSON.stringify({ accepted: true }), { status: 200 })
    }) as unknown as typeof fetch

    const result = await drainOutboxOnce(ports, drainRuntime({ fetch: fetchImpl }), 20)

    // The drain resolved at all (didn't reject) despite the hook throw.
    expect(result).toEqual({ delivered: 1, failedTerminal: 1, retried: 0 })
    // markFailedTerminal was called (and thus ran to completion) BEFORE the
    // hook's throw — deadLetter's own try/catch only wraps the hook call.
    expect(outbox.markFailedTerminalCalls).toEqual([
      { id: failRow.id, claimToken: 'tok-a', error: 'delivery failed: HTTP 403' },
    ])
    // The sibling deliverable row in the same batch still went through.
    expect(outbox.markDeliveredCalls).toEqual([{ id: goodRow.id, claimToken: 'tok-b' }])
  })
})

// ---------------------------------------------------------------------------
// §5.9 enqueueSend
// ---------------------------------------------------------------------------

function enqueueRuntime(overrides: Partial<EnqueueSendRuntime> = {}): EnqueueSendRuntime {
  let counter = 0
  return {
    now: () => NOW,
    uuid: () => `generated-id-${counter++}`,
    ...overrides,
  }
}

describe('enqueueSend', () => {
  test('invalid toAddress → ok:false, reason invalid_address (store never called)', async () => {
    const outbox = makeOutboxStore()
    const ports = makePorts({ outbox })
    const result = await enqueueSend(ports, enqueueRuntime(), {
      fromHandle: 'alice',
      toAddress: 'not-an-amtp-address',
      content: 'hi',
    })
    expect(result).toEqual({ ok: false, reason: 'invalid_address' })
    expect(outbox.rows.size).toBe(0)
  })

  test('valid send builds an unsigned envelope, defaults id via runtime.uuid(), enqueues with idempotencyKey = id', async () => {
    const outbox = makeOutboxStore()
    const ports = makePorts({ identity: makeIdentity('local-instance', 'pub', 'priv'), outbox })
    const result = await enqueueSend(ports, enqueueRuntime(), {
      fromHandle: 'alice',
      toAddress: 'amtp://peer-1/bob',
      content: 'hello',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.entry.envelope).toEqual({
      v: 1,
      id: 'generated-id-0',
      ts: NOW,
      from: 'amtp://local-instance/alice',
      to: 'amtp://peer-1/bob',
      subject: undefined,
      content: 'hello',
      inReplyTo: undefined,
      agentKey: undefined,
      agentSig: undefined,
      attachments: undefined,
    })
    expect(result.entry.peerInstanceId).toBe('peer-1')
    expect(outbox.rows.size).toBe(1)
  })

  test('blank/whitespace-only subject coerced to undefined; non-blank subject kept untrimmed', async () => {
    const outbox = makeOutboxStore()
    const ports = makePorts({ outbox })
    const blank = await enqueueSend(ports, enqueueRuntime(), {
      fromHandle: 'alice',
      toAddress: 'amtp://peer-1/bob',
      content: 'hi',
      subject: '   ',
      id: 'blank-subject-id',
    })
    if (!blank.ok) throw new Error('unreachable')
    expect(blank.entry.envelope.subject).toBeUndefined()

    const withSubject = await enqueueSend(ports, enqueueRuntime(), {
      fromHandle: 'alice',
      toAddress: 'amtp://peer-1/bob',
      content: 'hi',
      subject: '  hello there  ',
      id: 'with-subject-id',
    })
    if (!withSubject.ok) throw new Error('unreachable')
    expect(withSubject.entry.envelope.subject).toBe('  hello there  ')
  })

  test('explicit id is honored (pre-agreed envelope id for signed sends)', async () => {
    const outbox = makeOutboxStore()
    const ports = makePorts({ outbox })
    const result = await enqueueSend(ports, enqueueRuntime(), {
      fromHandle: 'alice',
      toAddress: 'amtp://peer-1/bob',
      content: 'hi',
      id: 'pre-agreed-id',
    })
    if (!result.ok) throw new Error('unreachable')
    expect(result.entry.envelope.id).toBe('pre-agreed-id')
  })

  test('empty attachments array is stored as undefined; non-empty is kept', async () => {
    const outbox = makeOutboxStore()
    const ports = makePorts({ outbox })
    const empty = await enqueueSend(ports, enqueueRuntime(), {
      fromHandle: 'alice',
      toAddress: 'amtp://peer-1/bob',
      content: 'hi',
      attachments: [],
      id: 'empty-attachments-id',
    })
    if (!empty.ok) throw new Error('unreachable')
    expect(empty.entry.envelope.attachments).toBeUndefined()

    const ref = { id: 'a1', filename: 'f.txt', contentType: 'text/plain', byteSize: 1, sha256: 'x' }
    const withAtt = await enqueueSend(ports, enqueueRuntime(), {
      fromHandle: 'alice',
      toAddress: 'amtp://peer-1/bob',
      content: 'hi',
      attachments: [ref],
      id: 'with-attachments-id',
    })
    if (!withAtt.ok) throw new Error('unreachable')
    expect(withAtt.entry.envelope.attachments).toEqual([ref])
  })

  test('idempotent enqueue: re-enqueuing the same id returns the store-defined existing entry unchanged', async () => {
    const outbox = makeOutboxStore()
    const ports = makePorts({ outbox })
    const first = await enqueueSend(ports, enqueueRuntime(), {
      fromHandle: 'alice',
      toAddress: 'amtp://peer-1/bob',
      content: 'hi',
      id: 'dup-id',
    })
    const second = await enqueueSend(ports, enqueueRuntime(), {
      fromHandle: 'alice',
      toAddress: 'amtp://peer-1/bob',
      content: 'a different body — must be ignored',
      id: 'dup-id',
    })
    if (!first.ok || !second.ok) throw new Error('unreachable')
    expect(second.entry.id).toBe(first.entry.id)
    expect(second.entry.envelope.content).toBe('hi')
    expect(outbox.rows.size).toBe(1)
  })
})
