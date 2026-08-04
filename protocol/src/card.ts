import { z } from 'zod'
import { jcsCanonicalize, type JsonValue } from './jcs'

export const CARD_NAME_MAX = 200
export const CARD_DESCRIPTION_MAX = 2000
export const SIGNED_CARD_MAX_BYTES = 16384
/** Domain-separation prefix for card signing (spec §4.6). */
export const CARD_SIG_DOMAIN = 'amtp-agent-card-v1'

/** Self-described agent metadata. Well-known core + open extensions bag. */
export interface AmtpAgentCard {
  name?: string
  description?: string
  extensions?: Record<string, JsonValue>
}

export interface AmtpSignedAgentCardSansSig {
  v: 1
  instanceId: string
  handle: string
  card: AmtpAgentCard
}

export interface AmtpSignedAgentCard extends AmtpSignedAgentCardSansSig {
  /** base64 (standard, padded) Ed25519 over canonicalAgentCardBytes. */
  cardSig: string
}

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([z.null(), z.boolean(), z.number().finite(), z.string(), z.array(jsonValueSchema), z.record(jsonValueSchema)])
)

/**
 * `.passthrough()` is load-bearing: unknown card fields must survive parsing
 * so the verifier canonicalizes the SAME value the signer signed (§13 says
 * ignore-unknown, but stripping inside a signed payload would break the sig).
 */
export const amtpAgentCardSchema = z
  .object({
    name: z.string().min(1).max(CARD_NAME_MAX).optional(),
    description: z.string().min(1).max(CARD_DESCRIPTION_MAX).optional(),
    extensions: z.record(jsonValueSchema).optional(),
  })
  .passthrough()

export const amtpSignedAgentCardSchema = z.object({
  v: z.literal(1),
  instanceId: z.string().min(1),
  handle: z.string().min(1),
  card: amtpAgentCardSchema,
  cardSig: z.string().min(1),
})

/** signingInput = UTF8(domain) || 0x00 || UTF8(JCS({v, instanceId, handle, card})). */
export function canonicalAgentCardBytes(input: AmtpSignedAgentCardSansSig): Uint8Array {
  // Payload is EXACTLY these four fields — unknown top-level keys are never signed.
  const jcs = jcsCanonicalize({ v: input.v, instanceId: input.instanceId, handle: input.handle, card: input.card })
  const enc = new TextEncoder()
  const domain = enc.encode(CARD_SIG_DOMAIN)
  const body = enc.encode(jcs)
  const out = new Uint8Array(domain.length + 1 + body.length)
  out.set(domain, 0)
  out[domain.length] = 0x00
  out.set(body, domain.length + 1)
  return out
}

/** UTF-8 byte size of the JSON-serialized signed card (cap: SIGNED_CARD_MAX_BYTES). */
export function signedCardByteSize(signedCard: unknown): number {
  return new TextEncoder().encode(JSON.stringify(signedCard)).length
}
