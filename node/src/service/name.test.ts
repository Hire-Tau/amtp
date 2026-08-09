import { describe, expect, test } from 'bun:test'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { deriveServiceName } from './name'

describe('deriveServiceName', () => {
  test('default home is plain "amtp"', () => {
    expect(deriveServiceName(join(homedir(), '.amtp'))).toBe('amtp')
  })

  test('default home given as a non-normalized path still matches', () => {
    expect(deriveServiceName(join(homedir(), 'x', '..', '.amtp'))).toBe('amtp')
  })

  test('non-default home gets amtp-<basename>-<hash6>', () => {
    const name = deriveServiceName('/tmp/amtp-a')
    expect(name).toMatch(/^amtp-amtp-a-[0-9a-f]{6}$/)
  })

  test('is deterministic and distinguishes different paths', () => {
    expect(deriveServiceName('/tmp/amtp-a')).toBe(deriveServiceName('/tmp/amtp-a'))
    expect(deriveServiceName('/tmp/amtp-a')).not.toBe(deriveServiceName('/tmp/amtp-b'))
  })

  test('sanitizes weird basenames to [a-z0-9-]', () => {
    expect(deriveServiceName('/tmp/My Homes/Node_A!')).toMatch(/^amtp-node-a-[0-9a-f]{6}$/)
  })

  test('all-symbol basename falls back to "home"', () => {
    expect(deriveServiceName('/tmp/___')).toMatch(/^amtp-home-[0-9a-f]{6}$/)
  })
})
