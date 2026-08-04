const SCHEME = 'amtp://'

/**
 * Parse an AMTP address of the exact form `amtp://<instanceId>/<handle>`.
 * Returns null unless both the instance id and a single handle segment are present
 * (no extra path segments, no empty parts).
 */
export function parseAmtpAddress(addr: string): { instanceId: string; handle: string } | null {
  if (typeof addr !== 'string' || !addr.startsWith(SCHEME)) return null
  const rest = addr.slice(SCHEME.length)
  const slash = rest.indexOf('/')
  if (slash <= 0) return null // missing handle separator or empty instance id
  const instanceId = rest.slice(0, slash)
  const handle = rest.slice(slash + 1)
  if (!instanceId || !handle) return null
  if (handle.includes('/')) return null // exactly one handle segment
  if (/\s/.test(instanceId) || /\s/.test(handle)) return null
  return { instanceId, handle }
}

/** Build an AMTP address: `amtp://<instanceId>/<handle>`. */
export function formatAmtpAddress(instanceId: string, handle: string): string {
  return `${SCHEME}${instanceId}/${handle}`
}
