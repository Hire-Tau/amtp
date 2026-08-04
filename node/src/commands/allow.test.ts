import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'bun:sqlite'
import { generateInstanceKeyPair } from 'amtp-protocol'
import { setCliHome } from '../context'
import { openDb } from '../db/open'
import { dbPath, ensureAmtpDirs } from '../home'
import { runInit } from '../ops/init'
import { addPeer } from '../ops/peers'
import { register } from '../ops/registrations'
import type { AllowRuleRow } from '../ops/allow'
import { setOutputOptions } from '../output'
import { registerAllowCommands } from './allow'
import { captureLogs, newProgram, parseJsonLog } from './test-helpers'

let workDir: string
let home: string

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'amtp-allow-cmd-test-'))
  home = join(workDir, 'home')
  ensureAmtpDirs(home)
  setCliHome(home)
  const init = runInit(home)
  const db: Database = openDb(dbPath(home))
  register(db, init.instanceId, { handle: 'alice' })
  addPeer(db, {
    alias: 'bob-peer',
    baseUrl: 'http://bob.example',
    publicKeyPem: generateInstanceKeyPair().publicKeyPem,
  })
  db.close()
  setOutputOptions({ json: true })
})

afterEach(() => {
  setOutputOptions({})
  rmSync(workDir, { recursive: true, force: true })
})

function buildProgram() {
  const program = newProgram()
  registerAllowCommands(program)
  return program
}

describe('amtp allow add/list/remove', () => {
  test('is registered with the expected shape', () => {
    const program = buildProgram()
    const allow = program.commands.find((c) => c.name() === 'allow')
    expect(allow?.commands.map((c) => c.name())).toEqual(['add', 'list', 'remove'])
  })

  test('add + list + remove round-trip', async () => {
    const addLogs = await captureLogs(() =>
      buildProgram().parseAsync(['allow', 'add', 'alice', '--peer', 'bob-peer', '--sender', 'bob'], { from: 'user' })
    )
    const { ruleId } = parseJsonLog<{ ruleId: string }>(addLogs)
    expect(ruleId).toBeTruthy()

    const listLogs = await captureLogs(() => buildProgram().parseAsync(['allow', 'list', 'alice'], { from: 'user' }))
    const rules = parseJsonLog<AllowRuleRow[]>(listLogs)
    expect(rules).toEqual([
      { ruleId, handle: 'alice', peerInstanceId: rules[0].peerInstanceId, kind: 'handle', value: 'bob' },
    ])

    await captureLogs(() => buildProgram().parseAsync(['allow', 'remove', ruleId], { from: 'user' }))
    const afterRemove = await captureLogs(() => buildProgram().parseAsync(['allow', 'list', 'alice'], { from: 'user' }))
    expect(parseJsonLog<AllowRuleRow[]>(afterRemove)).toHaveLength(0)
  })
})
