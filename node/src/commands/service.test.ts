import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setCliHome } from '../context'
import { runInit } from '../ops/init'
import { setOutputOptions } from '../output'
import { LaunchdManager } from '../service/launchd'
import { deriveServiceName } from '../service/name'
import type { Runner, ServiceStatus } from '../service/types'
import { registerServiceCommands, setServiceManagerFactory } from './service'
import { captureLogs, newProgram, parseJsonLog } from './test-helpers'

let workDir: string
let home: string
let agentsDir: string
let calls: string[][]

const okRunner: Runner = async (cmd) => {
  calls.push(cmd)
  return { exitCode: 0, stdout: '', stderr: '' }
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'amtp-service-cmd-test-'))
  home = join(workDir, 'home')
  agentsDir = join(workDir, 'LaunchAgents')
  calls = []
  setCliHome(home)
  setOutputOptions({ json: true })
  // Force the launchd backend with a recording runner and a temp
  // LaunchAgents dir so tests behave identically on any CI platform and
  // never touch the real ~/Library/LaunchAgents.
  setServiceManagerFactory(
    (input) =>
      new LaunchdManager({
        ctx: {
          home: resolve(input.home),
          name: deriveServiceName(resolve(input.home)),
          execStart: ['/bin/amtp', 'serve'],
        },
        runner: okRunner,
        uid: 501,
        launchAgentsDir: agentsDir,
      })
  )
})

afterEach(() => {
  setServiceManagerFactory(undefined)
  setOutputOptions({})
  rmSync(workDir, { recursive: true, force: true })
})

function buildProgram() {
  const program = newProgram()
  registerServiceCommands(program)
  return program
}

describe('amtp service', () => {
  test('is registered with the expected verbs', () => {
    const program = buildProgram()
    const service = program.commands.find((c) => c.name() === 'service')
    expect(service?.commands.map((c) => c.name())).toEqual([
      'install',
      'uninstall',
      'start',
      'stop',
      'restart',
      'status',
      'logs',
    ])
  })

  test('install refuses an uninitialized home', async () => {
    // no runInit(home) here
    let exitCode: number | undefined
    const originalExit = process.exit
    const originalError = console.error
    const errors: string[] = []
    // outputError calls process.exit(1); intercept it like a commander test.
    process.exit = ((code?: number) => {
      exitCode = code
      throw new Error('exit')
    }) as never
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(' '))
    }
    try {
      await expect(buildProgram().parseAsync(['service', 'install'], { from: 'user' })).rejects.toThrow('exit')
    } finally {
      process.exit = originalExit
      console.error = originalError
    }
    expect(exitCode).toBe(1)
    expect(errors.join('\n')).toContain('amtp home not initialized')
    expect(errors.join('\n')).toContain('amtp init')
  })

  test('install on an initialized home reports status + warnings as JSON', async () => {
    runInit(home)
    const logs = await captureLogs(() => buildProgram().parseAsync(['service', 'install'], { from: 'user' }))
    const printed = parseJsonLog<ServiceStatus & { warnings: string[] }>(logs)
    expect(printed.name).toMatch(/^amtp-home-[0-9a-f]{6}$/)
    expect(printed.installed).toBe(true)
    expect(printed.warnings).toEqual([])
    expect(calls.some((c) => c[0] === 'launchctl' && c[1] === 'bootstrap')).toBe(true)
  })

  test('status of a never-installed service reports installed:false', async () => {
    runInit(home)
    const logs = await captureLogs(() => buildProgram().parseAsync(['service', 'status'], { from: 'user' }))
    const printed = parseJsonLog<ServiceStatus>(logs)
    expect(printed.installed).toBe(false)
    expect(printed.running).toBe(false)
  })

  test('uninstall of a never-installed service is a no-op notice', async () => {
    runInit(home)
    const logs = await captureLogs(() => buildProgram().parseAsync(['service', 'uninstall'], { from: 'user' }))
    const printed = parseJsonLog<{ name: string; removed: boolean }>(logs)
    expect(printed.removed).toBe(false)
  })
})
