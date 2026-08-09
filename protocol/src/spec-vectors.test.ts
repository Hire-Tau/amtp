import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  instanceIdFromPublicKeyPem,
  signEnvelope,
  verifyEnvelope,
  canonicalPeerGetString,
  derivePeerGetSignedPath,
  validateLegacySignedGetPathPrefix,
  parseAmtpAddress,
  formatAmtpAddress,
  canonicalAgentSigBytes,
  canonicalAgentCardBytes,
  signAgentCard,
  verifyAgentCard,
  CARD_SIG_DOMAIN,
  amtpSignedAgentCardSchema,
  type AmtpSignedAgentCard,
} from './index'

/**
 * Conformance test for the AMTP protocol golden vectors under protocol/vectors/.
 *
 * These vectors are the normative appendix of docs/SPEC.md (Appendix A). This test
 * proves the generator, the committed JSON, and the live production code all agree: it re-derives
 * every vector value with the SAME production functions the vectors claim to describe, and asserts
 * exact equality. An independent implementation is conformant with the spec iff it reproduces
 * every vector byte-for-byte from this same JSON.
 */
const VECTORS_DIR = join(import.meta.dir, '..', 'vectors')

function loadVector<T>(filename: string): T {
  return JSON.parse(readFileSync(join(VECTORS_DIR, filename), 'utf8')) as T
}

interface AddressesVectors {
  valid: { input: string; instanceId: string; handle: string }[]
  invalid: string[]
}

interface InstanceIdentityVectors {
  vectors: { publicKeyPem: string; instanceId: string }[]
}

interface EnvelopeSignatureVectors {
  keys: { publicKeyPem: string; privateKeyPem: string; instanceId: string }
  vectors: { name: string; bodyUtf8: string; signatureB64: string }[]
}

interface AgentSignatureVectors {
  keys: { publicKeyPem: string; privateKeyPem: string }
  vectors: {
    name: string
    fields: Parameters<typeof canonicalAgentSigBytes>[0]
    canonicalUtf8: string
    signatureB64: string
  }[]
}

interface GetCanonicalVectors {
  keys: { publicKeyPem: string; privateKeyPem: string; instanceId: string }
  vectors: { method: string; path: string; timestampMs: number; canonicalUtf8: string; signatureB64: string }[]
}

interface AgentCardVectors {
  keys: { publicKeyPem: string; privateKeyPem: string }
  instanceId: string
  vectors: Array<{ name: string; signedCard: AmtpSignedAgentCard; jcsUtf8: string }>
}

interface GetPathDerivationVectors {
  vectors: Array<{
    name: string
    peerBaseUrl: string
    route: string
    legacySignedGetPathPrefix?: string
    signedPath: string
  }>
}

describe('AMTP spec vectors: addresses.json', () => {
  const data = loadVector<AddressesVectors>('addresses.json')

  test('valid addresses parse to the expected instanceId/handle and roundtrip through format', () => {
    for (const { input, instanceId, handle } of data.valid) {
      expect(parseAmtpAddress(input)).toEqual({ instanceId, handle })
      expect(formatAmtpAddress(instanceId, handle)).toBe(input)
    }
  })

  test('invalid addresses fail to parse', () => {
    for (const input of data.invalid) {
      expect(parseAmtpAddress(input)).toBeNull()
    }
  })
})

describe('AMTP spec vectors: instance-identity.json', () => {
  const data = loadVector<InstanceIdentityVectors>('instance-identity.json')

  test('instanceId derivation matches for every vector', () => {
    for (const { publicKeyPem, instanceId } of data.vectors) {
      expect(instanceIdFromPublicKeyPem(publicKeyPem)).toBe(instanceId)
    }
  })
})

describe('AMTP spec vectors: envelope-signature.json', () => {
  const data = loadVector<EnvelopeSignatureVectors>('envelope-signature.json')

  test('instanceId in the vector file matches the key', () => {
    expect(instanceIdFromPublicKeyPem(data.keys.publicKeyPem)).toBe(data.keys.instanceId)
  })

  for (const vector of data.vectors) {
    test(`${vector.name}: signEnvelope reproduces signatureB64 and verifies`, () => {
      const bytes = new TextEncoder().encode(vector.bodyUtf8)
      expect(signEnvelope(data.keys.privateKeyPem, bytes)).toBe(vector.signatureB64)
      expect(verifyEnvelope(data.keys.publicKeyPem, bytes, vector.signatureB64)).toBe(true)
    })

    test(`${vector.name}: a tampered byte fails verification`, () => {
      const tampered = new TextEncoder().encode(vector.bodyUtf8 + ' ')
      expect(verifyEnvelope(data.keys.publicKeyPem, tampered, vector.signatureB64)).toBe(false)
    })
  }
})

describe('AMTP spec vectors: agent-signature.json', () => {
  const data = loadVector<AgentSignatureVectors>('agent-signature.json')

  for (const vector of data.vectors) {
    test(`${vector.name}: canonicalAgentSigBytes reproduces canonicalUtf8 and signature verifies`, () => {
      const canonicalBytes = canonicalAgentSigBytes(vector.fields)
      const canonicalUtf8 = new TextDecoder().decode(canonicalBytes)
      expect(canonicalUtf8).toBe(vector.canonicalUtf8)
      expect(signEnvelope(data.keys.privateKeyPem, canonicalBytes)).toBe(vector.signatureB64)
      expect(verifyEnvelope(data.keys.publicKeyPem, canonicalBytes, vector.signatureB64)).toBe(true)
    })

    test(`${vector.name}: a tampered byte fails verification`, () => {
      const canonicalBytes = canonicalAgentSigBytes(vector.fields)
      const tampered = new Uint8Array([...canonicalBytes, 0x20])
      expect(verifyEnvelope(data.keys.publicKeyPem, tampered, vector.signatureB64)).toBe(false)
    })
  }

  test('subject-whitespace-only-omitted vector proves a whitespace-only subject is omitted, not kept as ""', () => {
    const vector = data.vectors.find((v) => v.name === 'subject-whitespace-only-omitted')!
    expect(vector.canonicalUtf8).not.toContain('"subject"')
  })

  test('attachments-scrambled vector proves sha256 sorting: canonical order differs from input order', () => {
    const vector = data.vectors.find((v) => v.name === 'attachments-scrambled')!
    const inputOrder = vector.fields.attachments.map((a) => a.filename)
    const canonical = JSON.parse(vector.canonicalUtf8)
    const canonicalOrder = canonical.attachments.map((a: { filename: string }) => a.filename)
    expect(inputOrder).not.toEqual(canonicalOrder)
    // sorted ascending by sha256
    const sha256s = canonical.attachments.map((a: { sha256: string }) => a.sha256)
    expect(sha256s).toEqual([...sha256s].sort())
  })
})

describe('AMTP spec vectors: get-canonical.json', () => {
  const data = loadVector<GetCanonicalVectors>('get-canonical.json')

  test('instanceId in the vector file matches the key', () => {
    expect(instanceIdFromPublicKeyPem(data.keys.publicKeyPem)).toBe(data.keys.instanceId)
  })

  for (const vector of data.vectors) {
    test(`${vector.method} ${vector.path}: canonicalPeerGetString reproduces canonicalUtf8 and signature verifies`, () => {
      const canonicalUtf8 = canonicalPeerGetString(vector.method, vector.path, vector.timestampMs)
      expect(canonicalUtf8).toBe(vector.canonicalUtf8)
      const bytes = new TextEncoder().encode(canonicalUtf8)
      expect(signEnvelope(data.keys.privateKeyPem, bytes)).toBe(vector.signatureB64)
      expect(verifyEnvelope(data.keys.publicKeyPem, bytes, vector.signatureB64)).toBe(true)
    })

    test(`${vector.method} ${vector.path}: a tampered byte fails verification`, () => {
      const bytes = new TextEncoder().encode(vector.canonicalUtf8 + '!')
      expect(verifyEnvelope(data.keys.publicKeyPem, bytes, vector.signatureB64)).toBe(false)
    })
  }
})

describe('AMTP spec vectors: get-path-derivation.json', () => {
  const data = loadVector<GetPathDerivationVectors>('get-path-derivation.json')

  for (const vector of data.vectors) {
    test(vector.name, () => {
      expect(
        derivePeerGetSignedPath(vector.peerBaseUrl, vector.route, vector.legacySignedGetPathPrefix)
      ).toBe(vector.signedPath)
    })
  }

  test('rejects invalid legacy signed GET prefixes consistently', () => {
    for (const value of ['api', '/', '/api/', ' /api', '/api path', '/api?x', '/api#x', '/api\\path']) {
      expect(() => validateLegacySignedGetPathPrefix(value)).toThrow(
        new TypeError('invalid legacy signed GET path prefix')
      )
      expect(() => derivePeerGetSignedPath('https://peer.example', '/amtp/handles', value)).toThrow(
        new TypeError('invalid legacy signed GET path prefix')
      )
    }
  })
})

describe('AMTP spec vectors: agent-card.json', () => {
  const data = loadVector<AgentCardVectors>('agent-card.json')

  for (const vector of data.vectors) {
    const { signedCard, jcsUtf8 } = vector
    const sansSig = {
      v: signedCard.v,
      instanceId: signedCard.instanceId,
      handle: signedCard.handle,
      card: signedCard.card,
    }

    test(`${vector.name}: canonical bytes = domain || 0x00 || pinned JCS`, () => {
      const bytes = canonicalAgentCardBytes(sansSig)
      expect(new TextDecoder().decode(bytes)).toBe(`${CARD_SIG_DOMAIN}\u0000${jcsUtf8}`)
    })

    test(`${vector.name}: signature reproduces and verifies`, () => {
      expect(signAgentCard(data.keys.privateKeyPem, sansSig)).toBe(signedCard.cardSig)
      expect(verifyAgentCard(data.keys.publicKeyPem, signedCard)).toBe(true)
      expect(amtpSignedAgentCardSchema.safeParse(signedCard).success).toBe(true)
    })

    test(`${vector.name}: any tampered signed field fails verification`, () => {
      expect(verifyAgentCard(data.keys.publicKeyPem, { ...signedCard, handle: 'tampered' })).toBe(false)
      expect(verifyAgentCard(data.keys.publicKeyPem, { ...signedCard, instanceId: 'tampered' })).toBe(false)
      expect(
        verifyAgentCard(data.keys.publicKeyPem, {
          ...signedCard,
          card: { ...signedCard.card, description: 'tampered' },
        })
      ).toBe(false)
    })
  }
})
