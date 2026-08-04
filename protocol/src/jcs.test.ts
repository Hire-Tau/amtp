import { describe, test, expect } from 'bun:test'
import { jcsCanonicalize } from './jcs'

describe('jcsCanonicalize (RFC 8785)', () => {
  test('sorts object keys by UTF-16 code units (RFC 8785 §3.2.3 example)', () => {
    const input = {
      '€': 'Euro Sign',
      '\r': 'Carriage Return',
      '\uFB33': 'Hebrew Letter Dalet With Dagesh',
      '1': 'One',
      '😀': 'Emoji: Grinning Face',
      '\u0080': 'Control',
      ö: 'Latin Small Letter O With Diaeresis',
    }
    expect(jcsCanonicalize(input)).toBe(
      '{"\\r":"Carriage Return","1":"One","\u0080":"Control","ö":"Latin Small Letter O With Diaeresis","€":"Euro Sign","😀":"Emoji: Grinning Face","\uFB33":"Hebrew Letter Dalet With Dagesh"}'
    )
  })

  test('nested objects and arrays canonicalize recursively', () => {
    expect(jcsCanonicalize({ b: [2, 1, { z: null, a: true }], a: 'x' })).toBe('{"a":"x","b":[2,1,{"a":true,"z":null}]}')
  })

  test('numbers serialize in ECMAScript shortest form', () => {
    expect(jcsCanonicalize({ big: 1e21, small: 1e-7, frac: 0.000001, int: 10, negzero: -0 })).toBe(
      '{"big":1e+21,"frac":0.000001,"int":10,"negzero":0,"small":1e-7}'
    )
  })

  test('strings escape like JSON.stringify (control chars short forms, non-ASCII literal)', () => {
    expect(jcsCanonicalize({ s: 'a\u0000b\nZoë😀' })).toBe('{"s":"a\\u0000b\\nZoë😀"}')
  })

  test('throws on non-finite numbers and non-JSON types', () => {
    expect(() => jcsCanonicalize({ x: NaN })).toThrow()
    expect(() => jcsCanonicalize({ x: Infinity })).toThrow()
    expect(() => jcsCanonicalize({ x: 1n as unknown })).toThrow()
    expect(() => jcsCanonicalize(undefined)).toThrow()
  })

  test('skips object keys whose value is undefined (JSON.stringify parity)', () => {
    expect(jcsCanonicalize({ a: 1, b: undefined as unknown })).toBe('{"a":1}')
  })

  test('output equals JSON.parse round-trip canonical form', () => {
    const v = JSON.parse('{"z":{"k2":[true,false],"k1":"v"},"a":1.5}')
    expect(jcsCanonicalize(v)).toBe('{"a":1.5,"z":{"k1":"v","k2":[true,false]}}')
  })
})
