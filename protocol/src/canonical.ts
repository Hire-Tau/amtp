/** The minimal envelope subset that `agentSig` signs. Excludes ts, inReplyTo, attachment id. */
export interface AgentSigSubset {
  v: 1
  id: string
  from: string
  to: string
  subject?: string
  content: string
  attachments: { filename: string; contentType: string; byteSize: number; sha256: string }[]
}

/**
 * Pinned canonical serialization of the agentSig subset. MUST be byte-identical on
 * both the signing (CLI) and verifying (Core) sides or agentSig never verifies:
 * - subject trimmed; empty → omitted
 * - attachments reduced to {filename,contentType,byteSize,sha256}, sorted by sha256,
 *   and omitted entirely when empty
 * - stable key order: v, id, from, to, (subject), content, (attachments)
 */
export function canonicalAgentSigBytes(subset: AgentSigSubset): Uint8Array {
  const subject = subset.subject?.trim()
  const attachments = subset.attachments
    .map((a) => ({ filename: a.filename, contentType: a.contentType, byteSize: a.byteSize, sha256: a.sha256 }))
    .sort((a, b) => (a.sha256 < b.sha256 ? -1 : a.sha256 > b.sha256 ? 1 : 0))
  const canonical: Record<string, unknown> = { v: subset.v, id: subset.id, from: subset.from, to: subset.to }
  if (subject) canonical.subject = subject
  canonical.content = subset.content
  if (attachments.length > 0) canonical.attachments = attachments
  return new TextEncoder().encode(JSON.stringify(canonical))
}
