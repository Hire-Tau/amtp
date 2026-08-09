import { describe, expect, test } from 'bun:test'
import { canonicalPeerGetString, generateInstanceKeyPair, verifyEnvelope } from 'amtp-protocol'
import { createDefaultAttachmentPull } from './attachment-pull'
import { sha256Hex } from './sha256'

const keys = generateInstanceKeyPair()
const bytes = new TextEncoder().encode('x')

function ref(id: string) {
  return { id, filename: 'x', contentType: 'text/plain', byteSize: 1, sha256: sha256Hex(bytes) }
}

describe('createDefaultAttachmentPull signed path', () => {
  for (const id of ['%2F', '%2f', '%41', 'A', '%252F', '%20', '%C3%A9']) {
    test(`preserves byte-stable URL spelling ${id}`, async () => {
      let pathname = ''
      let signature = ''
      const pull = createDefaultAttachmentPull({
        signing: async () => ({ instanceId: 'self', privateKeyPem: keys.privateKeyPem }),
        getCaps: async () => ({ maxAttachmentBytes: 10, maxTotalAttachmentBytes: 10, maxTotalStorageBytes: 10 }),
        now: () => 123,
        fetch: (async (url: string, init: RequestInit) => {
          pathname = new URL(url).pathname
          signature = (init.headers as Record<string, string>)['x-amtp-signature']
          return new Response(bytes)
        }) as unknown as typeof fetch,
      })
      await pull({ peerBaseUrl: 'https://peer.example/public', ref: ref(id) })
      expect(pathname).toBe(`/public/amtp/attachments/${id}`)
      expect(verifyEnvelope(keys.publicKeyPem, new TextEncoder().encode(canonicalPeerGetString('GET', `/amtp/attachments/${id}`, 123)), signature)).toBe(true)
    })
  }

  test('supports an explicit legacy prefix without changing the request URL', async () => {
    let url = ''
    let signature = ''
    const pull = createDefaultAttachmentPull({
      signing: async () => ({ instanceId: 'self', privateKeyPem: keys.privateKeyPem }),
      getCaps: async () => ({ maxAttachmentBytes: 10, maxTotalAttachmentBytes: 10, maxTotalStorageBytes: 10 }),
      now: () => 123,
      fetch: (async (requested: string, init: RequestInit) => {
        url = requested
        signature = (init.headers as Record<string, string>)['x-amtp-signature']
        return new Response(bytes)
      }) as unknown as typeof fetch,
    })
    await pull({ peerBaseUrl: 'https://peer.example/public', legacySignedGetPathPrefix: '/internal', ref: ref('A') })
    expect(url).toBe('https://peer.example/public/amtp/attachments/A')
    expect(verifyEnvelope(keys.publicKeyPem, new TextEncoder().encode(canonicalPeerGetString('GET', '/internal/amtp/attachments/A', 123)), signature)).toBe(true)
  })
})
