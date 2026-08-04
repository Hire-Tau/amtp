/** Canonical bytes a peer signs to authenticate a bodyless GET. Signer and verifier MUST agree exactly. */
export function canonicalPeerGetString(method: string, path: string, timestampMs: number): string {
  return `${method}\n${path}\n${timestampMs}`
}

export const PEER_GET_FRESHNESS_MS = 300000
