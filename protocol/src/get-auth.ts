export function validateLegacySignedGetPathPrefix(value: string): string {
  if (!value.startsWith('/') || value === '/' || value.endsWith('/') || /[\s?#\\]/u.test(value)) {
    throw new TypeError('invalid legacy signed GET path prefix')
  }
  return value
}

/** Derive signed PATH from an AMTP route, independent of the peer URL mount path. */
export function derivePeerGetSignedPath(
  peerBaseUrl: string,
  route: string,
  legacySignedGetPathPrefix?: string
): string {
  new URL(peerBaseUrl)
  const routePath = new URL(route, 'https://amtp.invalid').pathname
  const prefix = legacySignedGetPathPrefix === undefined
    ? ''
    : validateLegacySignedGetPathPrefix(legacySignedGetPathPrefix)
  return `${prefix}${routePath}`
}

/** Canonical bytes a peer signs to authenticate a bodyless GET. Signer and verifier MUST agree exactly. */
export function canonicalPeerGetString(method: string, path: string, timestampMs: number): string {
  return `${method}\n${path}\n${timestampMs}`
}

export const PEER_GET_FRESHNESS_MS = 300000
