import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setCliHome } from '../context'
import { runInit } from '../ops/init'
import { setOutputOptions } from '../output'
import { registerDrainCommand, registerOutboxCommands } from './outbox'
import { captureLogs, newProgram, parseJsonLog } from './test-helpers'

let workDir: string
let home: string
let originalFetch: typeof globalThis.fetch

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'amtp-outbox-cmd-test-'))
  home = join(workDir, 'home')
  setCliHome(home)
  runInit(home)
  setOutputOptions({ json: true })
  originalFetch = globalThis.fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  setOutputOptions({})
  rmSync(workDir, { recursive: true, force: true })
})

describe('amtp outbox list', () => {
  test('is registered with the expected shape', () => {
    const program = newProgram()
    registerOutboxCommands(program)
    const outbox = program.commands.find((c) => c.name() === 'outbox')
    expect(outbox?.commands.map((c) => c.name())).toEqual(['list'])
  })

  test('lists an empty outbox as []', async () => {
    const program = newProgram()
    registerOutboxCommands(program)
    const logs = await captureLogs(() => program.parseAsync(['outbox', 'list'], { from: 'user' }))
    expect(parseJsonLog<unknown[]>(logs)).toEqual([])
  })
})

describe('amtp drain', () => {
  test('is registered as a top-level command', () => {
    const program = newProgram()
    registerDrainCommand(program)
    expect(program.commands.map((c) => c.name())).toEqual(['drain'])
  })

  test('runs one drain pass and prints the result summary', async () => {
    const program = newProgram()
    registerDrainCommand(program)
    globalThis.fetch = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch

    const logs = await captureLogs(() => program.parseAsync(['drain'], { from: 'user' }))
    expect(parseJsonLog<{ delivered: number; retried: number; failedTerminal: number }>(logs)).toEqual({
      delivered: 0,
      retried: 0,
      failedTerminal: 0,
    })
  })
})
