/**
 * RFC 8785 JSON Canonicalization Scheme (JCS), hand-written (the package
 * purity gate forbids external deps). Used for agent-card signing where the
 * open `extensions` bag rules out fixed-field serialization (canonical.ts).
 *
 * Properties (RFC 8785):
 * - Object keys sorted by UTF-16 code units (§3.2.3) — JS default string sort.
 * - Strings/numbers serialize exactly like ECMAScript JSON.stringify
 *   (shortest-form numbers, short-form escapes, non-ASCII literal).
 * - No insignificant whitespace.
 * - Object keys with `undefined` values are skipped (JSON.stringify parity);
 *   any other non-JSON value (NaN, Infinity, bigint, function, symbol) throws.
 */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export function jcsCanonicalize(value: unknown): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      if (!Number.isFinite(value)) throw new Error('JCS: non-finite number')
      return JSON.stringify(value)
    case 'string':
      return JSON.stringify(value)
    case 'object':
      break
    default:
      throw new Error(`JCS: unsupported type ${typeof value}`)
  }
  if (Array.isArray(value)) return `[${value.map((v) => jcsCanonicalize(v)).join(',')}]`
  const obj = value as Record<string, unknown>
  // Default sort() compares UTF-16 code units — exactly RFC 8785 §3.2.3.
  const parts: string[] = []
  for (const key of Object.keys(obj).sort()) {
    if (obj[key] === undefined) continue
    parts.push(`${JSON.stringify(key)}:${jcsCanonicalize(obj[key])}`)
  }
  return `{${parts.join(',')}}`
}
