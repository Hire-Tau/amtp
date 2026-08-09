import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'bun:sqlite'
import { generateInstanceKeyPair, instanceIdFromPublicKeyPem } from 'amtp-protocol'
import { openDb } from '../db/open'
import { dbPath, ensureAmtpDirs } from '../home'
import { addPeer, listPeers, removePeer, resolvePeer } from './peers'

let workDir: string
let home: string
let db: Database

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'amtp-peers-test-'))
  home = join(workDir, 'home')
  ensureAmtpDirs(home)
  db = openDb(dbPath(home))
})

afterEach(() => {
  db.close()
  rmSync(workDir, { recursive: true, force: true })
})

describe('addPeer', () => {
  test('derives the instance id from the public key and stores an active peer', () => {
    const { publicKeyPem } = generateInstanceKeyPair()
    const expectedId = instanceIdFromPublicKeyPem(publicKeyPem)

    const peer = addPeer(db, { alias: 'friend', baseUrl: 'http://peer.example', publicKeyPem })

    expect(peer).toEqual({
      instanceId: expectedId,
      alias: 'friend',
      baseUrl: 'http://peer.example',
      publicKeyPem,
      status: 'active',
    })
  })


  test('validates and round-trips an exact legacy signed GET prefix', () => {
    const { publicKeyPem } = generateInstanceKeyPair()
    const peer = addPeer(db, { alias: 'legacy', baseUrl: 'http://peer.example', publicKeyPem, legacySignedGetPathPrefix: '/internal%2Fmount' })
    expect(peer.legacySignedGetPathPrefix).toBe('/internal%2Fmount')
    expect(resolvePeer(db, 'legacy')?.legacySignedGetPathPrefix).toBe('/internal%2Fmount')
    expect(listPeers(db)[0].legacySignedGetPathPrefix).toBe('/internal%2Fmount')
  })

  test('rejects invalid legacy signed GET prefixes', () => {
    for (const legacySignedGetPathPrefix of ['api', '/', '/api/', '/api path', '/api?x', '/api#x', '/api\\path']) {
      const { publicKeyPem } = generateInstanceKeyPair()
      expect(() => addPeer(db, { alias: `bad-${Math.random()}`, baseUrl: 'http://peer.example', publicKeyPem, legacySignedGetPathPrefix })).toThrow('invalid legacy signed GET path prefix')
    }
  })
  test('accepts a matching explicit --instance-id', () => {
    const { publicKeyPem } = generateInstanceKeyPair()
    const expectedId = instanceIdFromPublicKeyPem(publicKeyPem)
    const peer = addPeer(db, { alias: 'friend', baseUrl: 'http://peer.example', publicKeyPem, instanceId: expectedId })
    expect(peer.instanceId).toBe(expectedId)
  })

  test('rejects a mismatching explicit --instance-id (self-certification check, AMTP.md §4.2)', () => {
    const { publicKeyPem } = generateInstanceKeyPair()
    expect(() =>
      addPeer(db, { alias: 'friend', baseUrl: 'http://peer.example', publicKeyPem, instanceId: 'not-the-real-id' })
    ).toThrow(/does not match/)
  })
})

describe('listPeers / resolvePeer / removePeer', () => {
  test('lists peers sorted by alias and resolves by alias or instance id', () => {
    const a = generateInstanceKeyPair()
    const b = generateInstanceKeyPair()
    addPeer(db, { alias: 'zeta', baseUrl: 'http://z.example', publicKeyPem: a.publicKeyPem })
    addPeer(db, { alias: 'alpha', baseUrl: 'http://a.example', publicKeyPem: b.publicKeyPem })

    expect(listPeers(db).map((p) => p.alias)).toEqual(['alpha', 'zeta'])

    const byAlias = resolvePeer(db, 'zeta')
    expect(byAlias?.baseUrl).toBe('http://z.example')
    const byInstanceId = resolvePeer(db, byAlias!.instanceId)
    expect(byInstanceId?.alias).toBe('zeta')
    expect(resolvePeer(db, 'unknown')).toBeNull()
  })

  test('removePeer deletes the row and reports whether anything was removed', () => {
    const { publicKeyPem } = generateInstanceKeyPair()
    addPeer(db, { alias: 'friend', baseUrl: 'http://peer.example', publicKeyPem })

    expect(removePeer(db, 'friend')).toBe(true)
    expect(resolvePeer(db, 'friend')).toBeNull()
    expect(removePeer(db, 'friend')).toBe(false)
  })
})
