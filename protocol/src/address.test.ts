import { describe, test, expect } from 'bun:test'
import { parseAmtpAddress, formatAmtpAddress } from './address'

describe('amtp address', () => {
  test('parse + format roundtrip', () => {
    expect(parseAmtpAddress('amtp://abc/alice')).toEqual({ instanceId: 'abc', handle: 'alice' })
    expect(formatAmtpAddress('abc', 'alice')).toBe('amtp://abc/alice')
    expect(parseAmtpAddress(formatAmtpAddress('x', 'y'))).toEqual({ instanceId: 'x', handle: 'y' })
  })

  test('rejects malformed addresses', () => {
    expect(parseAmtpAddress('http://x/y')).toBeNull()
    expect(parseAmtpAddress('amtp://onlyinstance')).toBeNull()
    expect(parseAmtpAddress('amtp:///handle')).toBeNull()
    expect(parseAmtpAddress('amtp://inst/a/b')).toBeNull()
  })
})
