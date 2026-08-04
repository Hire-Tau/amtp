import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'bun:sqlite'
import { formatAmtpAddress } from 'amtp-protocol'
import { openDb } from '../db/open'
import { dbPath, ensureAmtpDirs } from '../home'
import { setCard } from './cards'
import { runInit } from './init'
import { getIdentity, getWhoami } from './identity'
import { register } from './registrations'

let workDir: string
let home: string
let db: Database

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'amtp-identity-test-'))
  home = join(workDir, 'home')
  ensureAmtpDirs(home)
})

afterEach(() => {
  db?.close()
  rmSync(workDir, { recursive: true, force: true })
})

describe('getIdentity', () => {
  test('throws a pointer to amtp init when nothing was ever initialized', () => {
    db = openDb(dbPath(home))
    expect(() => getIdentity(db)).toThrow(/amtp init/)
  })

  test('returns the identity row written by runInit', () => {
    const init = runInit(home)
    db = openDb(dbPath(home))
    expect(getIdentity(db)).toEqual({ instanceId: init.instanceId, publicKeyPem: init.publicKeyPem })
  })
})

describe('getWhoami', () => {
  test('lists every registration with its full amtp:// address', () => {
    const init = runInit(home)
    db = openDb(dbPath(home))
    register(db, init.instanceId, { handle: 'alice' })
    register(db, init.instanceId, { handle: 'bob', open: true })

    const whoami = getWhoami(db)
    expect(whoami.instanceId).toBe(init.instanceId)
    expect(whoami.registrations).toEqual([
      {
        handle: 'alice',
        address: formatAmtpAddress(init.instanceId, 'alice'),
        inboundOpen: false,
        agentPublicKeyPem: whoami.registrations[0].agentPublicKeyPem,
      },
      {
        handle: 'bob',
        address: formatAmtpAddress(init.instanceId, 'bob'),
        inboundOpen: true,
        agentPublicKeyPem: whoami.registrations[1].agentPublicKeyPem,
      },
    ])
    expect(whoami.registrations[0].agentPublicKeyPem).toContain('PUBLIC KEY')
  })

  test('returns an empty registrations list on a freshly initialized home', () => {
    const init = runInit(home)
    db = openDb(dbPath(home))
    expect(getWhoami(db)).toEqual({ instanceId: init.instanceId, registrations: [] })
  })

  test('a registration gains `name` once a card is published, and loses it once cleared', () => {
    const init = runInit(home)
    db = openDb(dbPath(home))
    register(db, init.instanceId, { handle: 'alice' })
    expect(getWhoami(db).registrations[0].name).toBeUndefined()

    setCard(db, init.instanceId, { handle: 'alice', name: 'Alice' })
    expect(getWhoami(db).registrations[0].name).toBe('Alice')
  })

  test('degrades to no `name` (never throws) on a corrupt card_json row', () => {
    const init = runInit(home)
    db = openDb(dbPath(home))
    register(db, init.instanceId, { handle: 'alice' })
    db.run('UPDATE registrations SET card_json = ? WHERE handle = ?', ['{not valid json', 'alice'])

    expect(() => getWhoami(db)).not.toThrow()
    expect(getWhoami(db).registrations[0].name).toBeUndefined()
  })
})
