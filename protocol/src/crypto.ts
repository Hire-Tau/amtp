import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto'
import { canonicalAgentCardBytes, type AmtpSignedAgentCard, type AmtpSignedAgentCardSansSig } from './card'

/** Generate an Ed25519 keypair as PEM strings (SPKI public, PKCS8 private). */
export function generateInstanceKeyPair(): { publicKeyPem: string; privateKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }) as string,
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
  }
}

/** Self-certifying instance id: base64url(sha256(SPKI DER of the public key)). */
export function instanceIdFromPublicKeyPem(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' })
  return createHash('sha256').update(der).digest('base64url')
}

/**
 * Detached Ed25519 signature over raw envelope bytes.
 * For Ed25519, the algorithm argument to `sign` MUST be `null`.
 * Returns a base64 signature.
 */
export function signEnvelope(privateKeyPem: string, bytes: Uint8Array): string {
  return sign(null, bytes, createPrivateKey(privateKeyPem)).toString('base64')
}

/**
 * Verify a base64 Ed25519 signature over raw envelope bytes.
 * Wrapped in try/catch so a malformed key or signature yields `false`
 * rather than throwing (the receiver middleware must not crash on hostile input).
 */
export function verifyEnvelope(publicKeyPem: string, bytes: Uint8Array, signatureB64: string): boolean {
  try {
    return verify(null, bytes, createPublicKey(publicKeyPem), Buffer.from(signatureB64, 'base64'))
  } catch {
    return false
  }
}

/** Sign an agent card with the agent's identity private key (spec §4.6). */
export function signAgentCard(privateKeyPem: string, sansSig: AmtpSignedAgentCardSansSig): string {
  return signEnvelope(privateKeyPem, canonicalAgentCardBytes(sansSig))
}

/**
 * Verify a signed card against a (pinned) agent identity public key.
 * Recomputes canonical bytes from the received {v, instanceId, handle, card}.
 * Exception-safe: malformed input yields false, never throws.
 */
export function verifyAgentCard(publicKeyPem: string, signedCard: AmtpSignedAgentCard): boolean {
  try {
    const bytes = canonicalAgentCardBytes({
      v: signedCard.v,
      instanceId: signedCard.instanceId,
      handle: signedCard.handle,
      card: signedCard.card,
    })
    return verifyEnvelope(publicKeyPem, bytes, signedCard.cardSig)
  } catch {
    return false
  }
}
