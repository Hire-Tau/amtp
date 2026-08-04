import { describe, test, expect } from 'bun:test'
import { canonicalAgentSigBytes, type AgentSigSubset } from './canonical'
import { amtpEnvelopeSchema } from './envelope'

const dec = (b: Uint8Array) => new TextDecoder().decode(b)

const base: AgentSigSubset = {
  v: 1,
  id: 'id-1',
  from: 'amtp://inst-a/alice',
  to: 'amtp://inst-b/bob',
  subject: 'hi',
  content: 'hello',
  attachments: [],
}

describe('canonicalAgentSigBytes', () => {
  test('is independent of ts, inReplyTo, and attachment id', () => {
    const a = canonicalAgentSigBytes(base)
    // Passing the same logical subset plus runtime-only ignored fields must produce identical bytes.
    const b = canonicalAgentSigBytes({ ...base, ts: Date.now(), inReplyTo: 'x' } as any)
    expect(dec(a)).toBe(dec(b))
    expect(dec(a)).not.toContain('ts')
    expect(dec(a)).not.toContain('inReplyTo')
    // Attachment-level id must also be stripped from signed bytes.
    const withAttId = canonicalAgentSigBytes({
      ...base,
      attachments: [{ id: 'att-99', filename: 'f.txt', contentType: 'text/plain', byteSize: 5, sha256: 'ccc' } as any],
    })
    expect(dec(withAttId)).not.toContain('"id":"att-99"')
  })

  test('normalizes subject (trim; empty omitted)', () => {
    expect(dec(canonicalAgentSigBytes({ ...base, subject: '  hi  ' }))).toBe(dec(canonicalAgentSigBytes(base)))
    const noSubject = canonicalAgentSigBytes({ ...base, subject: '   ' })
    expect(dec(noSubject)).not.toContain('subject')
  })

  test('sorts attachments by sha256 (order independent)', () => {
    const att1 = { filename: 'a.txt', contentType: 'text/plain', byteSize: 1, sha256: 'bbb' }
    const att2 = { filename: 'b.txt', contentType: 'text/plain', byteSize: 2, sha256: 'aaa' }
    const forward = canonicalAgentSigBytes({ ...base, attachments: [att1, att2] })
    const reverse = canonicalAgentSigBytes({ ...base, attachments: [att2, att1] })
    expect(dec(forward)).toBe(dec(reverse))
    // aaa precedes bbb in the serialized output.
    expect(dec(forward).indexOf('aaa')).toBeLessThan(dec(forward).indexOf('bbb'))
  })

  test('excludes attachment id from the signed bytes', () => {
    // Pass an attachment with a runtime `id` field; it must be stripped from canonical bytes.
    const withAttId = canonicalAgentSigBytes({
      ...base,
      attachments: [{ id: 'att-db-uuid', filename: 'a', contentType: 'text/plain', byteSize: 1, sha256: 'aaa' } as any],
    })
    expect(dec(withAttId)).not.toContain('"id":"att-db-uuid"')
    // Envelope id IS included (it's part of authorship).
    expect(dec(withAttId)).toContain('"id":"id-1"')
  })
})

const envelopeBase = { v: 1 as const, id: 'e1', ts: 1, from: 'amtp://A/h', to: 'amtp://B/g', content: 'hi' }
const ref = { id: 'a1', filename: 'f.txt', contentType: 'text/plain', byteSize: 3, sha256: 'abc' }

describe('amtpEnvelopeSchema attachments', () => {
  test('accepts an envelope with no attachments field', () => {
    expect(amtpEnvelopeSchema.safeParse(envelopeBase).success).toBe(true)
  })
  test('accepts a valid attachments array', () => {
    const r = amtpEnvelopeSchema.safeParse({ ...envelopeBase, attachments: [ref] })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.attachments?.[0].sha256).toBe('abc')
  })
  test('rejects an empty-string filename (min(1) convention)', () => {
    const r = amtpEnvelopeSchema.safeParse({ ...envelopeBase, attachments: [{ ...ref, filename: '' }] })
    expect(r.success).toBe(false)
  })
  test('rejects a missing sha256', () => {
    const { sha256, ...noHash } = ref
    const r = amtpEnvelopeSchema.safeParse({ ...envelopeBase, attachments: [noHash] })
    expect(r.success).toBe(false)
  })
  test('rejects a negative byteSize', () => {
    const r = amtpEnvelopeSchema.safeParse({ ...envelopeBase, attachments: [{ ...ref, byteSize: -1 }] })
    expect(r.success).toBe(false)
  })
})
