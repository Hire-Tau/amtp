import { describe, expect, test } from 'bun:test'
import { canonicalPeerGetString, generateInstanceKeyPair, verifyEnvelope } from 'amtp-protocol'
import { fetchPeerHandles, listHandles, serveAgentKey } from './discovery'
import type { AmtpEnginePorts } from './options'
import type { AttachmentStore, HandleDirectory, OutboxStore } from './ports'
import { serveAttachment } from './serve'
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

// fetchPeerHandles signs with the identity's PRIVATE key (§5.8) — a
// placeholder non-PEM string throws inside signEnvelope itself. Use a real
// generated keypair as the default identity so only the intentionally
// exercised behavior (the HTTP response) is under test.
const DEFAULT_IDENTITY_KEYS = generateInstanceKeyPair()

function defaultOutboxStore(authorizedFor: Map<string, Set<string>> = new Map()): OutboxStore {
  return makeOutboxStore([], { authorizedAttachmentsFor: authorizedFor })
}

function defaultAttachmentStore(): AttachmentStore {
  return makeAttachmentStore()
}

function defaultHandleDirectory(): HandleDirectory {
  return makeHandleDirectory()
}

function makePorts(overrides: Partial<AmtpEnginePorts> = {}): AmtpEnginePorts {
  return {
    identity:
      overrides.identity ??
      makeIdentity('self-instance', DEFAULT_IDENTITY_KEYS.publicKeyPem, DEFAULT_IDENTITY_KEYS.privateKeyPem),
    peers: overrides.peers ?? makePeerStore(),
    pins: overrides.pins ?? makePinStore(),
    replays: overrides.replays ?? makeReplayLedger(),
    outbox: overrides.outbox ?? defaultOutboxStore(),
    attachments: overrides.attachments ?? defaultAttachmentStore(),
    handles: overrides.handles ?? defaultHandleDirectory(),
    policy: overrides.policy ?? makeReceivePolicy(),
    delivery: overrides.delivery ?? makeDeliveryHooks(),
  }
}

// ---------------------------------------------------------------------------
// §5.5 serveAttachment — default-deny 404 uniformity
// ---------------------------------------------------------------------------

describe('serveAttachment', () => {
  test('authorized + blob present → found:true with the metadata byteSize (not bytes.length)', async () => {
    const bytes = new TextEncoder().encode('hello attachment')
    const blobs = new Map([['att-1', { bytes, contentType: 'text/plain', byteSize: 12345 }]])
    const outbox = makeOutboxStore([], { authorizedAttachmentsFor: new Map([['peer-1', new Set(['att-1'])]]) })
    const attachments = makeAttachmentStore({ blobs })
    const ports = makePorts({ outbox, attachments })

    const result = await serveAttachment(ports, { peerInstanceId: 'peer-1', attachmentId: 'att-1' })

    expect(result).toEqual({ found: true, bytes, contentType: 'text/plain', byteSize: 12345 })
  })

  const failureModes: Array<{
    name: string
    authorizedFor: Map<string, Set<string>>
    blobs: Map<string, { bytes: Uint8Array; contentType: string; byteSize: number }>
    peerInstanceId: string
    attachmentId: string
  }> = [
    {
      name: 'peer never had this attachment advertised to it (default-deny, no outbox row)',
      authorizedFor: new Map(),
      blobs: new Map(),
      peerInstanceId: 'peer-1',
      attachmentId: 'att-1',
    },
    {
      name: 'attachment was advertised to a DIFFERENT peer, not the requesting one',
      authorizedFor: new Map([['peer-2', new Set(['att-1'])]]),
      blobs: new Map([['att-1', { bytes: new TextEncoder().encode('x'), contentType: 'text/plain', byteSize: 1 }]]),
      peerInstanceId: 'peer-1',
      attachmentId: 'att-1',
    },
    {
      name: 'authorized, but the attachment id is unknown to the store (readOutboundBlob → null)',
      authorizedFor: new Map([['peer-1', new Set(['att-unknown'])]]),
      blobs: new Map(),
      peerInstanceId: 'peer-1',
      attachmentId: 'att-unknown',
    },
    {
      name: 'authorized, id known, but the blob is missing/unreadable on disk (readOutboundBlob → null)',
      authorizedFor: new Map([['peer-1', new Set(['att-missing-blob'])]]),
      blobs: new Map(), // store maps unreadable-on-disk to null too — same as unknown id from the engine's view
      peerInstanceId: 'peer-1',
      attachmentId: 'att-missing-blob',
    },
  ]

  for (const mode of failureModes) {
    test(`default-deny 404 uniformity: ${mode.name} → identical {found:false}`, async () => {
      const outbox = makeOutboxStore([], { authorizedAttachmentsFor: mode.authorizedFor })
      const attachments = makeAttachmentStore({ blobs: mode.blobs })
      const ports = makePorts({ outbox, attachments })

      const result = await serveAttachment(ports, {
        peerInstanceId: mode.peerInstanceId,
        attachmentId: mode.attachmentId,
      })

      expect(result).toEqual({ found: false })
    })
  }

  test('all four failure modes produce the exact same result shape (no distinguishing signal leaks)', async () => {
    const results = await Promise.all(
      failureModes.map((mode) => {
        const outbox = makeOutboxStore([], { authorizedAttachmentsFor: mode.authorizedFor })
        const attachments = makeAttachmentStore({ blobs: mode.blobs })
        const ports = makePorts({ outbox, attachments })
        return serveAttachment(ports, { peerInstanceId: mode.peerInstanceId, attachmentId: mode.attachmentId })
      })
    )
    for (const r of results) {
      expect(r).toEqual({ found: false })
    }
  })
})

// ---------------------------------------------------------------------------
// §5.6 listHandles — handles shape
// ---------------------------------------------------------------------------

describe('listHandles', () => {
  test('wraps each directory-listed handle as { handle } (§11 discovery serve shape)', async () => {
    const handles: HandleDirectory = {
      async resolve() {
        return null
      },
      async list() {
        return [{ handle: 'alice' }, { handle: 'bob' }]
      },
      async getCard() {
        return null
      },
    }
    const ports = makePorts({ handles })

    const result = await listHandles(ports)

    expect(result).toEqual({ handles: [{ handle: 'alice' }, { handle: 'bob' }] })
  })

  test('empty directory → empty handles array', async () => {
    const ports = makePorts()
    const result = await listHandles(ports)
    expect(result).toEqual({ handles: [] })
  })
})

// ---------------------------------------------------------------------------
// §5.7 serveAgentKey — echoed request handle
// ---------------------------------------------------------------------------

describe('serveAgentKey', () => {
  test('registered handle with a published key → found:true, echoes the REQUEST handle + this instance identity', async () => {
    const handles: HandleDirectory = {
      async resolve(h) {
        return h === 'alice' ? { recipientRef: 'agent-1', inboundOpen: true, agentPublicKeyPem: 'alice-pub-key' } : null
      },
      async list() {
        return [{ handle: 'alice' }]
      },
      async getCard() {
        return null
      },
    }
    const identity = {
      async get() {
        return { instanceId: 'our-instance-id', publicKeyPem: 'our-pub', privateKeyPem: 'our-priv' }
      },
      async getSigning() {
        return { instanceId: 'our-instance-id', privateKeyPem: 'our-priv' }
      },
    }
    const ports = makePorts({ handles, identity })

    const result = await serveAgentKey(ports, 'alice')

    expect(result).toEqual({
      found: true,
      handle: 'alice',
      instanceId: 'our-instance-id',
      identityPublicKey: 'alice-pub-key',
    })
  })

  test('unregistered handle → found:false', async () => {
    const ports = makePorts()
    const result = await serveAgentKey(ports, 'nobody')
    expect(result).toEqual({ found: false })
  })

  test('registered handle with NO published key (agentPublicKeyPem null) → found:false', async () => {
    const handles: HandleDirectory = {
      async resolve() {
        return { recipientRef: 'agent-1', inboundOpen: true, agentPublicKeyPem: null }
      },
      async list() {
        return [{ handle: 'alice' }]
      },
      async getCard() {
        return null
      },
    }
    const ports = makePorts({ handles })
    const result = await serveAgentKey(ports, 'alice')
    expect(result).toEqual({ found: false })
  })
})

// ---------------------------------------------------------------------------
// §5.8 fetchPeerHandles — client-side discovery fetch
// ---------------------------------------------------------------------------

describe('fetchPeerHandles', () => {
  test('happy path: signed GET to <base>/amtp/handles, filters non-string handle entries', async () => {
    let capturedUrl: string | undefined
    let capturedInit: RequestInit | undefined
    const fetchImpl = (async (url: string, init: RequestInit) => {
      capturedUrl = url
      capturedInit = init
      return new Response(
        JSON.stringify({ handles: [{ handle: 'alice' }, { handle: 42 }, { notHandle: 'x' }, { handle: 'bob' }] }),
        { status: 200 }
      )
    }) as unknown as typeof fetch

    const ports = makePorts()
    const result = await fetchPeerHandles(
      ports,
      { now: () => 1_700_000_000_000, fetch: fetchImpl },
      {
        peerBaseUrl: 'https://peer.example/api/',
      }
    )

    expect(result).toEqual({ ok: true, handles: [{ handle: 'alice' }, { handle: 'bob' }] })
    expect(capturedUrl).toBe('https://peer.example/api/amtp/handles')
    const headers = capturedInit!.headers as Record<string, string>
    expect(headers['x-amtp-instance']).toBe('self-instance')
    expect(headers['x-amtp-signature']).toBeTruthy()
    expect(headers['x-amtp-timestamp']).toBe('1700000000000')
    expect(
      verifyEnvelope(
        DEFAULT_IDENTITY_KEYS.publicKeyPem,
        new TextEncoder().encode(canonicalPeerGetString('GET', '/amtp/handles', 1_700_000_000_000)),
        headers['x-amtp-signature']
      )
    ).toBe(true)
    expect(
      verifyEnvelope(
        DEFAULT_IDENTITY_KEYS.publicKeyPem,
        new TextEncoder().encode(canonicalPeerGetString('GET', '/api/amtp/handles', 1_700_000_000_000)),
        headers['x-amtp-signature']
      )
    ).toBe(false)
  })

  test('explicit compatibility prefix changes only the signed path', async () => {
    let capturedUrl = ''
    let signature = ''
    const fetchImpl = (async (url: string, init: RequestInit) => {
      capturedUrl = url
      signature = (init.headers as Record<string, string>)['x-amtp-signature']
      return new Response(JSON.stringify({ handles: [] }), { status: 200 })
    }) as unknown as typeof fetch

    await fetchPeerHandles(
      makePorts(),
      { now: () => 123, fetch: fetchImpl },
      { peerBaseUrl: 'https://peer.example/public', legacySignedGetPathPrefix: '/internal' }
    )

    expect(capturedUrl).toBe('https://peer.example/public/amtp/handles')
    expect(
      verifyEnvelope(
        DEFAULT_IDENTITY_KEYS.publicKeyPem,
        new TextEncoder().encode(canonicalPeerGetString('GET', '/internal/amtp/handles', 123)),
        signature
      )
    ).toBe(true)
  })

  test('network throw → ok:false', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    const ports = makePorts()
    const result = await fetchPeerHandles(ports, { now: () => 0, fetch: fetchImpl }, { peerBaseUrl: 'https://x' })
    expect(result).toEqual({ ok: false })
  })

  test('non-2xx response → ok:false', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 502 })) as unknown as typeof fetch
    const ports = makePorts()
    const result = await fetchPeerHandles(ports, { now: () => 0, fetch: fetchImpl }, { peerBaseUrl: 'https://x' })
    expect(result).toEqual({ ok: false })
  })

  test('unparseable JSON body → ok:false', async () => {
    const fetchImpl = (async () => new Response('not json', { status: 200 })) as unknown as typeof fetch
    const ports = makePorts()
    const result = await fetchPeerHandles(ports, { now: () => 0, fetch: fetchImpl }, { peerBaseUrl: 'https://x' })
    expect(result).toEqual({ ok: false })
  })

  test('handles field not an array → ok:false', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ handles: 'nope' }), { status: 200 })) as unknown as typeof fetch
    const ports = makePorts()
    const result = await fetchPeerHandles(ports, { now: () => 0, fetch: fetchImpl }, { peerBaseUrl: 'https://x' })
    expect(result).toEqual({ ok: false })
  })
})
