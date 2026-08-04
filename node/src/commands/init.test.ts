import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setCliHome } from '../context'
import { dbPath } from '../home'
import { setOutputOptions } from '../output'
import { registerInitCommand } from './init'
import { captureLogs, newProgram } from './test-helpers'

let workDir: string
let home: string

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'amtp-init-cmd-test-'))
  home = join(workDir, 'home')
  // Mirrors what the root program's `preAction` hook does at real invocation
  // time — set directly here since these tests register only this one
  // command group, not the full program.
  setCliHome(home)
})

afterEach(() => {
  setOutputOptions({})
  rmSync(workDir, { recursive: true, force: true })
})

function buildProgram() {
  const program = newProgram()
  registerInitCommand(program)
  return program
}

describe('amtp init', () => {
  test('is registered with the expected shape', () => {
    const program = buildProgram()
    const init = program.commands.find((c) => c.name() === 'init')
    expect(init).toBeDefined()
  })

  test('creates the db and prints the instance identity under --json', async () => {
    setOutputOptions({ json: true })
    const logs = await captureLogs(() => buildProgram().parseAsync(['init'], { from: 'user' }))

    expect(existsSync(dbPath(home))).toBe(true)
    const printed = JSON.parse(logs.join('')) as { instanceId: string; alreadyInitialized: boolean }
    expect(printed.alreadyInitialized).toBe(false)
    expect(printed.instanceId).toBeTruthy()
  })

  test('re-running is an idempotent no-op', async () => {
    setOutputOptions({ json: true })
    await captureLogs(() => buildProgram().parseAsync(['init'], { from: 'user' }))
    const logs = await captureLogs(() => buildProgram().parseAsync(['init'], { from: 'user' }))

    const printed = JSON.parse(logs.join('')) as { alreadyInitialized: boolean }
    expect(printed.alreadyInitialized).toBe(true)
  })
})
