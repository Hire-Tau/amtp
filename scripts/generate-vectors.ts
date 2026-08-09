/**
 * Deterministic generator for the AMTP protocol golden vectors under protocol/vectors/.
 *
 * Imports the SAME production crypto/canonicalization functions the server uses — it never
 * reimplements signing or canonical serialization. Re-running this script must produce
 * byte-identical JSON (verify with `git diff --exit-code protocol/vectors`); the fixed
 * key PEMs and fixed ids/timestamps below are what make that determinism possible (Ed25519
 * sign is itself deterministic per RFC 8032).
 *
 * Run: `bun scripts/generate-vectors.ts`
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  instanceIdFromPublicKeyPem,
  signEnvelope,
  verifyEnvelope,
  canonicalPeerGetString,
  derivePeerGetSignedPath,
  parseAmtpAddress,
  formatAmtpAddress,
  canonicalAgentSigBytes,
  jcsCanonicalize,
  signAgentCard,
  verifyAgentCard,
  type AmtpAgentCard,
} from '../protocol/src/index'

const VECTORS_DIR = join(import.meta.dir, '..', 'protocol', 'vectors')

// Fixed Ed25519 keypairs, generated once off-line via `generateInstanceKeyPair()` (see the task
// brief, Step 1) and pasted here as constants so every run of this script is byte-identical
// (Ed25519 signing is deterministic per RFC 8032).
const INSTANCE_PUBLIC_KEY_PEM =
  '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAulajAXixmSWMzaQKwsOygobTUl+dkzlG8rN+Ur+ku14=\n-----END PUBLIC KEY-----\n'
const INSTANCE_PRIVATE_KEY_PEM =
  '-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIJklCMpn31cpVDf8YaKDd4m0M8aYb8zOyHp1qTQUvDTC\n-----END PRIVATE KEY-----\n'
const AGENT_PUBLIC_KEY_PEM =
  '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAan4IZHy8/s0crvZqloO0gkQVTbV4Qt5SaiR8tzMp5to=\n-----END PUBLIC KEY-----\n'
const AGENT_PRIVATE_KEY_PEM =
  '-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIKgc/qLl8QxM/8fLurNood33/iZ80wyST1QWpHLtBeKF\n-----END PRIVATE KEY-----\n'

const INSTANCE_ID = instanceIdFromPublicKeyPem(INSTANCE_PUBLIC_KEY_PEM)
const AGENT_INSTANCE_ID = instanceIdFromPublicKeyPem(AGENT_PUBLIC_KEY_PEM)

function writeJson(filename: string, data: unknown): void {
  writeFileSync(join(VECTORS_DIR, filename), JSON.stringify(data, null, 2) + '\n', 'utf8')
}

function assert(cond: boolean, message: string): void {
  if (!cond) throw new Error(`generate-amtp-vectors: assertion failed: ${message}`)
}

// ---------------------------------------------------------------------------
// addresses.json
// ---------------------------------------------------------------------------
function buildAddresses() {
  const validInputs = [
    formatAmtpAddress(INSTANCE_ID, 'support'),
    formatAmtpAddress(AGENT_INSTANCE_ID, 'billing-bot'),
    'amtp://abc123/x',
    'amtp://xyz.example.com/agent_1',
    'amtp://0/a',
    // U+0085 (NEXT LINE) is a control character, not a member of the ECMAScript RegExp `\s`
    // set — the reference parser's whitespace check (`/\s/`) does not match it, so a handle
    // containing NEL is valid per §3.
    'amtp://abc123/nelhandle',
  ]
  const valid = validInputs.map((input) => {
    const parsed = parseAmtpAddress(input)
    assert(parsed !== null, `expected valid address to parse: ${input}`)
    return { input, instanceId: parsed!.instanceId, handle: parsed!.handle }
  })

  const invalid = [
    'amtp://',
    'amtp://x',
    'amtp://x/',
    'amtp://x/a/b',
    'tau://x/a',
    'amtp://x /a',
    'not-an-address',
    // U+FEFF (ZERO WIDTH NO-BREAK SPACE / BOM) IS a member of the ECMAScript RegExp `\s`
    // set, so a handle containing it is rejected per §3.
    'amtp://abc123/bom﻿handle',
  ]
  for (const input of invalid) {
    assert(parseAmtpAddress(input) === null, `expected invalid address to fail to parse: ${input}`)
  }

  return { valid, invalid }
}

// ---------------------------------------------------------------------------
// instance-identity.json
// ---------------------------------------------------------------------------
function buildInstanceIdentity() {
  return {
    vectors: [
      { publicKeyPem: INSTANCE_PUBLIC_KEY_PEM, instanceId: INSTANCE_ID },
      { publicKeyPem: AGENT_PUBLIC_KEY_PEM, instanceId: AGENT_INSTANCE_ID },
    ],
  }
}

// ---------------------------------------------------------------------------
// envelope-signature.json — transport signature over exact body bytes (JSON.stringify(envelope))
// ---------------------------------------------------------------------------
function buildEnvelopeSignature() {
  const textOnlyEnvelope = {
    v: 1,
    id: '11111111-1111-4111-8111-111111111111',
    ts: 1700000000000,
    from: formatAmtpAddress(INSTANCE_ID, 'support'),
    to: formatAmtpAddress(AGENT_INSTANCE_ID, 'billing'),
    subject: 'Test Subject',
    content: 'Hello, this is a test message.',
  }
  const withAttachmentsEnvelope = {
    v: 1,
    id: '22222222-2222-4222-8222-222222222222',
    ts: 1700000001000,
    from: formatAmtpAddress(INSTANCE_ID, 'support'),
    to: formatAmtpAddress(AGENT_INSTANCE_ID, 'billing'),
    content: 'See the attached file.',
    attachments: [
      {
        id: 'att-1',
        filename: 'report.pdf',
        contentType: 'application/pdf',
        byteSize: 2048,
        sha256: 'a3f1c2b9e4d5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f',
      },
    ],
  }

  const vectors = [
    { name: 'text-only', envelope: textOnlyEnvelope },
    { name: 'with-attachments', envelope: withAttachmentsEnvelope },
  ].map(({ name, envelope }) => {
    const bodyUtf8 = JSON.stringify(envelope)
    const bytes = new TextEncoder().encode(bodyUtf8)
    const signatureB64 = signEnvelope(INSTANCE_PRIVATE_KEY_PEM, bytes)
    assert(verifyEnvelope(INSTANCE_PUBLIC_KEY_PEM, bytes, signatureB64), `envelope-signature ${name} must verify`)
    return { name, bodyUtf8, signatureB64 }
  })

  return {
    keys: { publicKeyPem: INSTANCE_PUBLIC_KEY_PEM, privateKeyPem: INSTANCE_PRIVATE_KEY_PEM, instanceId: INSTANCE_ID },
    vectors,
  }
}

// ---------------------------------------------------------------------------
// agent-signature.json — canonicalAgentSigBytes over the AgentSigSubset, signed with the agent key
// ---------------------------------------------------------------------------
function buildAgentSignature() {
  const from = formatAmtpAddress(INSTANCE_ID, 'alice')
  const to = formatAmtpAddress(AGENT_INSTANCE_ID, 'billing')

  const cases: { name: string; fields: Parameters<typeof canonicalAgentSigBytes>[0] }[] = [
    {
      name: 'subject-present',
      fields: {
        v: 1,
        id: 'aaaaaaaa-0000-4000-8000-000000000001',
        from,
        to,
        subject: 'Invoice question',
        content: 'Can you resend the invoice?',
        attachments: [],
      },
    },
    {
      name: 'subject-absent',
      fields: {
        v: 1,
        id: 'aaaaaaaa-0000-4000-8000-000000000002',
        from,
        to,
        content: 'No subject on this one.',
        attachments: [],
      },
    },
    {
      name: 'subject-needs-trim',
      fields: {
        v: 1,
        id: 'aaaaaaaa-0000-4000-8000-000000000003',
        from,
        to,
        subject: '   Padded Subject   ',
        content: 'Subject has surrounding whitespace.',
        attachments: [],
      },
    },
    {
      // Subject is present but trims to empty (whitespace-only) — canonicalUtf8 must OMIT the
      // subject key entirely, proving canonicalAgentSigBytes drops it rather than keeping "".
      name: 'subject-whitespace-only-omitted',
      fields: {
        v: 1,
        id: 'aaaaaaaa-0000-4000-8000-000000000005',
        from,
        to,
        subject: '   ',
        content: 'Subject is whitespace-only and must be omitted.',
        attachments: [],
      },
    },
    {
      // Attachments listed out of sha256 order in the input on purpose — canonicalUtf8 must
      // show them re-sorted ascending by sha256, proving canonicalAgentSigBytes sorts rather
      // than preserving input order.
      name: 'attachments-scrambled',
      fields: {
        v: 1,
        id: 'aaaaaaaa-0000-4000-8000-000000000004',
        from,
        to,
        subject: 'Files attached',
        content: 'Two files attached, listed out of digest order.',
        attachments: [
          {
            filename: 'zeta.txt',
            contentType: 'text/plain',
            byteSize: 20,
            sha256: 'ffff000000000000000000000000000000000000000000000000000000000000',
          },
          {
            filename: 'alpha.txt',
            contentType: 'text/plain',
            byteSize: 10,
            sha256: '1111000000000000000000000000000000000000000000000000000000000000',
          },
        ],
      },
    },
  ]

  const vectors = cases.map(({ name, fields }) => {
    const canonicalBytes = canonicalAgentSigBytes(fields)
    const canonicalUtf8 = new TextDecoder().decode(canonicalBytes)
    const signatureB64 = signEnvelope(AGENT_PRIVATE_KEY_PEM, canonicalBytes)
    assert(verifyEnvelope(AGENT_PUBLIC_KEY_PEM, canonicalBytes, signatureB64), `agent-signature ${name} must verify`)
    return { name, fields, canonicalUtf8, signatureB64 }
  })

  return {
    keys: { publicKeyPem: AGENT_PUBLIC_KEY_PEM, privateKeyPem: AGENT_PRIVATE_KEY_PEM },
    vectors,
  }
}

// ---------------------------------------------------------------------------
// get-canonical.json — canonicalPeerGetString over method/path/timestamp, signed with instance key
// ---------------------------------------------------------------------------
function buildGetCanonical() {
  const cases = [
    { method: 'GET', path: '/api/amtp/handles', timestampMs: 1700000000000 },
    { method: 'GET', path: '/api/amtp/attachments/att-123abc', timestampMs: 1700000005000 },
    { method: 'GET', path: '/api/amtp/identity', timestampMs: 1700000010000 },
  ]

  const vectors = cases.map(({ method, path, timestampMs }) => {
    const canonicalUtf8 = canonicalPeerGetString(method, path, timestampMs)
    const bytes = new TextEncoder().encode(canonicalUtf8)
    const signatureB64 = signEnvelope(INSTANCE_PRIVATE_KEY_PEM, bytes)
    assert(verifyEnvelope(INSTANCE_PUBLIC_KEY_PEM, bytes, signatureB64), `get-canonical ${path} must verify`)
    return { method, path, timestampMs, canonicalUtf8, signatureB64 }
  })

  return {
    keys: { publicKeyPem: INSTANCE_PUBLIC_KEY_PEM, privateKeyPem: INSTANCE_PRIVATE_KEY_PEM, instanceId: INSTANCE_ID },
    vectors,
  }
}

// ---------------------------------------------------------------------------
// get-path-derivation.json — proxy-stable route-relative signed paths
// ---------------------------------------------------------------------------
function buildGetPathDerivation() {
  const cases = [
    { name: 'root handles', peerBaseUrl: 'https://peer.example', route: '/amtp/handles' },
    { name: 'prefixed base ignored', peerBaseUrl: 'https://peer.example/public/api', route: '/amtp/handles' },
    { name: 'trailing base slash ignored', peerBaseUrl: 'https://peer.example/public/', route: '/amtp/handles' },
    { name: 'uppercase escaped slash preserved', peerBaseUrl: 'https://peer.example', route: '/amtp/attachments/%2F' },
    { name: 'lowercase escaped slash preserved', peerBaseUrl: 'https://peer.example', route: '/amtp/attachments/%2f' },
    { name: 'escaped A preserved', peerBaseUrl: 'https://peer.example', route: '/amtp/attachments/%41' },
    { name: 'literal A preserved', peerBaseUrl: 'https://peer.example', route: '/amtp/attachments/A' },
    { name: 'space and unicode encoded', peerBaseUrl: 'https://peer.example', route: '/amtp/attachments/a b-é' },
    { name: 'query and fragment excluded', peerBaseUrl: 'https://peer.example', route: '/amtp/handles?x=1#frag' },
    {
      name: 'explicit legacy prefix',
      peerBaseUrl: 'https://peer.example/public',
      route: '/amtp/handles',
      legacySignedGetPathPrefix: '/internal',
    },
  ]
  return {
    vectors: cases.map((vector) => ({
      ...vector,
      signedPath: derivePeerGetSignedPath(
        vector.peerBaseUrl,
        vector.route,
        vector.legacySignedGetPathPrefix
      ),
    })),
  }
}

// ---------------------------------------------------------------------------
// agent-card.json — canonicalAgentCardBytes over {v, instanceId, handle, card}, signed with the
// agent key
// ---------------------------------------------------------------------------
function buildAgentCard() {
  const instanceId = instanceIdFromPublicKeyPem(INSTANCE_PUBLIC_KEY_PEM)
  const cases: Array<{ name: string; handle: string; card: AmtpAgentCard }> = [
    { name: 'empty-card', handle: 'alice', card: {} },
    { name: 'name-only', handle: 'alice', card: { name: 'Support Concierge' } },
    {
      name: 'full-unsorted-extensions',
      handle: 'billing',
      card: {
        description: 'Handles invoices and refunds',
        name: 'Billing Agent',
        extensions: { zeta: 1e21, alpha: { b: [1, 2], a: 'x' }, '1': 'One', '€': 'euro-key' },
      },
    },
    {
      name: 'unicode-name',
      handle: 'zoe',
      card: { name: 'Zoë 😀', description: 'line one\u0085line two' },
    },
  ]
  const vectors = cases.map(({ name, handle, card }) => {
    const sansSig = { v: 1 as const, instanceId, handle, card }
    const jcsUtf8 = jcsCanonicalize({ v: 1, instanceId, handle, card })
    const cardSig = signAgentCard(AGENT_PRIVATE_KEY_PEM, sansSig)
    const signedCard = { ...sansSig, cardSig }
    assert(verifyAgentCard(AGENT_PUBLIC_KEY_PEM, signedCard), `agent-card vector ${name} must round-trip`)
    return { name, signedCard, jcsUtf8 }
  })
  return {
    keys: { publicKeyPem: AGENT_PUBLIC_KEY_PEM, privateKeyPem: AGENT_PRIVATE_KEY_PEM },
    instanceId,
    vectors,
  }
}

writeJson('addresses.json', buildAddresses())
writeJson('instance-identity.json', buildInstanceIdentity())
writeJson('envelope-signature.json', buildEnvelopeSignature())
writeJson('agent-signature.json', buildAgentSignature())
writeJson('get-canonical.json', buildGetCanonical())
writeJson('get-path-derivation.json', buildGetPathDerivation())
writeJson('agent-card.json', buildAgentCard())

console.log(`Wrote 7 vector files to ${VECTORS_DIR}`)
