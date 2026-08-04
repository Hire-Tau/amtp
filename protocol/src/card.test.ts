import { describe, test, expect } from 'bun:test'
import {
  amtpAgentCardSchema,
  amtpSignedAgentCardSchema,
  canonicalAgentCardBytes,
  signedCardByteSize,
  SIGNED_CARD_MAX_BYTES,
  type AmtpSignedAgentCardSansSig,
} from './card'
import { generateInstanceKeyPair, signAgentCard, verifyAgentCard } from './crypto'

const dec = (b: Uint8Array) => new TextDecoder().decode(b)
const keys = generateInstanceKeyPair()

const sansSig: AmtpSignedAgentCardSansSig = {
  v: 1,
  instanceId: 'inst-a',
  handle: 'alice',
  card: { name: 'Alice', description: 'Support agent', extensions: { zeta: 1, alpha: { b: [1, 2], a: 'x' } } },
}

describe('canonicalAgentCardBytes', () => {
  test('domain-separated JCS: prefix, 0x00, sorted-key JSON', () => {
    const s = dec(canonicalAgentCardBytes(sansSig))
    expect(s).toBe(
      'amtp-agent-card-v1\u0000' +
        '{"card":{"description":"Support agent","extensions":{"alpha":{"a":"x","b":[1,2]},"zeta":1},"name":"Alice"},"handle":"alice","instanceId":"inst-a","v":1}'
    )
  })

  test('absent optional card fields are omitted; extensions key order is irrelevant', () => {
    const a = canonicalAgentCardBytes({ v: 1, instanceId: 'i', handle: 'h', card: {} })
    expect(dec(a)).toBe('amtp-agent-card-v1\u0000{"card":{},"handle":"h","instanceId":"i","v":1}')
    const b1 = canonicalAgentCardBytes({ v: 1, instanceId: 'i', handle: 'h', card: { extensions: { a: 1, b: 2 } } })
    const b2 = canonicalAgentCardBytes({ v: 1, instanceId: 'i', handle: 'h', card: { extensions: { b: 2, a: 1 } } })
    expect(dec(b1)).toBe(dec(b2))
  })

  test('unknown card fields (passthrough) participate in the canonical bytes', () => {
    const parsed = amtpAgentCardSchema.parse({ name: 'A', custom: 'kept' })
    const withUnknown = canonicalAgentCardBytes({ v: 1, instanceId: 'i', handle: 'h', card: parsed })
    const without = canonicalAgentCardBytes({ v: 1, instanceId: 'i', handle: 'h', card: { name: 'A' } })
    expect(dec(withUnknown)).not.toBe(dec(without))
    expect(dec(withUnknown)).toContain('"custom":"kept"')
  })
})

describe('signAgentCard / verifyAgentCard', () => {
  test('round-trips; tampering any signed field fails', () => {
    const cardSig = signAgentCard(keys.privateKeyPem, sansSig)
    const signed = { ...sansSig, cardSig }
    expect(verifyAgentCard(keys.publicKeyPem, signed)).toBe(true)
    expect(verifyAgentCard(keys.publicKeyPem, { ...signed, handle: 'mallory' })).toBe(false)
    expect(verifyAgentCard(keys.publicKeyPem, { ...signed, instanceId: 'other' })).toBe(false)
    expect(verifyAgentCard(keys.publicKeyPem, { ...signed, card: { ...signed.card, name: 'Evil' } })).toBe(false)
  })

  test('verify is exception-safe on garbage keys/sigs', () => {
    const signed = { ...sansSig, cardSig: 'not-base64!' }
    expect(verifyAgentCard('not a pem', signed)).toBe(false)
    expect(verifyAgentCard(keys.publicKeyPem, signed)).toBe(false)
  })

  test('unknown TOP-LEVEL fields are not part of the signed payload', () => {
    const cardSig = signAgentCard(keys.privateKeyPem, sansSig)
    const withExtra = { ...sansSig, cardSig, extraTop: 'ignored' } as never
    expect(verifyAgentCard(keys.publicKeyPem, withExtra)).toBe(true)
  })
})

describe('schemas + limits', () => {
  test('caps: name ≤ 200, description ≤ 2000', () => {
    expect(amtpAgentCardSchema.safeParse({ name: 'x'.repeat(200) }).success).toBe(true)
    expect(amtpAgentCardSchema.safeParse({ name: 'x'.repeat(201) }).success).toBe(false)
    expect(amtpAgentCardSchema.safeParse({ description: 'x'.repeat(2001) }).success).toBe(false)
  })

  test('extensions reject non-JSON values', () => {
    expect(amtpAgentCardSchema.safeParse({ extensions: { ok: [1, 'a', null, { n: true }] } }).success).toBe(true)
    expect(amtpAgentCardSchema.safeParse({ extensions: { bad: Infinity } }).success).toBe(false)
  })

  test('signed schema requires all four fields + cardSig; card unknown keys survive', () => {
    const cardSig = signAgentCard(keys.privateKeyPem, sansSig)
    const ok = amtpSignedAgentCardSchema.safeParse({ ...sansSig, cardSig })
    expect(ok.success).toBe(true)
    expect(amtpSignedAgentCardSchema.safeParse({ ...sansSig }).success).toBe(false)
    const parsed = amtpSignedAgentCardSchema.parse({ ...sansSig, card: { name: 'A', keep: 1 }, cardSig: 'x' })
    expect((parsed.card as Record<string, unknown>).keep).toBe(1)
  })

  test('signedCardByteSize measures UTF-8 JSON bytes', () => {
    expect(signedCardByteSize({ a: 'é' })).toBe(new TextEncoder().encode('{"a":"é"}').length)
    expect(SIGNED_CARD_MAX_BYTES).toBe(16384)
  })
})
