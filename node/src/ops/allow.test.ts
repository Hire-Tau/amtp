import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'bun:sqlite'
import { generateInstanceKeyPair } from 'amtp-protocol'
import { openDb } from '../db/open'
import { dbPath, ensureAmtpDirs } from '../home'
import { runInit } from './init'
import { addPeer } from './peers'
import { register } from './registrations'
import { addAllowRule, listAllowRules, removeAllowRule } from './allow'

let workDir: string
let home: string
let db: Database
let instanceId: string

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'amtp-allow-test-'))
  home = join(workDir, 'home')
  ensureAmtpDirs(home)
  const init = runInit(home)
  instanceId = init.instanceId
  db = openDb(dbPath(home))
  register(db, instanceId, { handle: 'alice' })
  addPeer(db, {
    alias: 'bob-peer',
    baseUrl: 'http://bob.example',
    publicKeyPem: generateInstanceKeyPair().publicKeyPem,
  })
})

afterEach(() => {
  db.close()
  rmSync(workDir, { recursive: true, force: true })
})

describe('addAllowRule', () => {
  test('kind "any" when no --sender is given', () => {
    const result = addAllowRule(db, { handle: 'alice', peerRef: 'bob-peer' })
    const [rule] = listAllowRules(db, 'alice')
    expect(rule.ruleId).toBe(result.ruleId)
    expect(rule.kind).toBe('any')
    expect(rule.value).toBeNull()
  })

  test('kind "handle" scoped to --sender', () => {
    addAllowRule(db, { handle: 'alice', peerRef: 'bob-peer', senderHandle: 'bob' })
    const [rule] = listAllowRules(db, 'alice')
    expect(rule.kind).toBe('handle')
    expect(rule.value).toBe('bob')
  })

  test('throws for an unregistered handle', () => {
    expect(() => addAllowRule(db, { handle: 'ghost', peerRef: 'bob-peer' })).toThrow(/not registered/)
  })

  test('throws for an unknown peer', () => {
    expect(() => addAllowRule(db, { handle: 'alice', peerRef: 'ghost-peer' })).toThrow(/unknown peer/)
  })
})

describe('listAllowRules', () => {
  test('scopes to one handle when given, else lists everything', () => {
    register(db, instanceId, { handle: 'carol' })
    addAllowRule(db, { handle: 'alice', peerRef: 'bob-peer' })
    addAllowRule(db, { handle: 'carol', peerRef: 'bob-peer' })

    expect(listAllowRules(db, 'alice')).toHaveLength(1)
    expect(listAllowRules(db)).toHaveLength(2)
  })
})

describe('removeAllowRule', () => {
  test('deletes the rule and reports whether anything was removed', () => {
    const { ruleId } = addAllowRule(db, { handle: 'alice', peerRef: 'bob-peer' })
    expect(removeAllowRule(db, ruleId)).toBe(true)
    expect(listAllowRules(db, 'alice')).toHaveLength(0)
    expect(removeAllowRule(db, ruleId)).toBe(false)
  })
})
