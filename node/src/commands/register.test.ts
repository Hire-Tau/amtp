import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { verifyAgentCard } from 'amtp-protocol'
import type { AmtpSignedAgentCard } from 'amtp-protocol'
import { setCliHome } from '../context'
import { runInit } from '../ops/init'
import type { RegisterResult } from '../ops/registrations'
import { setOutputOptions } from '../output'
import { registerCloseCommand, registerOpenCommand, registerRegisterCommand } from './register'
import { captureLogs, newProgram, parseJsonLog } from './test-helpers'

let workDir: string
let home: string

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'amtp-register-cmd-test-'))
  home = join(workDir, 'home')
  setCliHome(home)
  runInit(home)
  setOutputOptions({ json: true })
})

afterEach(() => {
  setOutputOptions({})
  rmSync(workDir, { recursive: true, force: true })
})

function buildProgram() {
  const program = newProgram()
  registerRegisterCommand(program)
  registerOpenCommand(program)
  registerCloseCommand(program)
  return program
}

describe('amtp register / open / close', () => {
  test('is registered with the expected shape', () => {
    const program = buildProgram()
    expect(program.commands.map((c) => c.name())).toEqual(['register', 'open', 'close'])
    const register = program.commands.find((c) => c.name() === 'register')
    expect(register?.registeredArguments.map((a) => a.name())).toEqual(['handle'])
  })

  test('registers a handle and prints its address', async () => {
    const logs = await captureLogs(() => buildProgram().parseAsync(['register', 'alice'], { from: 'user' }))
    const printed = parseJsonLog<RegisterResult>(logs)
    expect(printed.alreadyRegistered).toBe(false)
    expect(printed.address).toContain('/alice')
  })

  test('re-registering is an idempotent no-op', async () => {
    await captureLogs(() => buildProgram().parseAsync(['register', 'alice'], { from: 'user' }))
    const logs = await captureLogs(() => buildProgram().parseAsync(['register', 'alice'], { from: 'user' }))
    const printed = parseJsonLog<RegisterResult>(logs)
    expect(printed.alreadyRegistered).toBe(true)
    expect(printed.regenerated).toBe(false)
  })

  test('--regenerate rotates the key and reports regenerated=true', async () => {
    const first = parseJsonLog<RegisterResult>(
      await captureLogs(() => buildProgram().parseAsync(['register', 'alice'], { from: 'user' }))
    )
    const second = parseJsonLog<RegisterResult>(
      await captureLogs(() => buildProgram().parseAsync(['register', 'alice', '--regenerate'], { from: 'user' }))
    )
    expect(second.regenerated).toBe(true)
    expect(second.agentPublicKeyPem).not.toBe(first.agentPublicKeyPem)
  })

  test('--name/--description publishes a card alongside the registration', async () => {
    const logs = await captureLogs(() =>
      buildProgram().parseAsync(['register', 'carol', '--name', 'Carol', '--description', 'Sales'], { from: 'user' })
    )
    const printed = parseJsonLog<RegisterResult & { card?: { card: { name?: string; description?: string } } }>(logs)
    expect(printed.alreadyRegistered).toBe(false)
    expect(printed.card?.card.name).toBe('Carol')
    expect(printed.card?.card.description).toBe('Sales')
  })

  test('registering without --name/--description publishes no card', async () => {
    const logs = await captureLogs(() => buildProgram().parseAsync(['register', 'dave'], { from: 'user' }))
    const printed = parseJsonLog<RegisterResult & { card?: unknown }>(logs)
    expect(printed.card).toBeUndefined()
  })

  test('--regenerate together with --name re-signs the card with the NEW key', async () => {
    await captureLogs(() => buildProgram().parseAsync(['register', 'erin', '--name', 'Erin Old'], { from: 'user' }))
    const logs = await captureLogs(() =>
      buildProgram().parseAsync(['register', 'erin', '--regenerate', '--name', 'Erin New'], { from: 'user' })
    )
    const printed = parseJsonLog<RegisterResult & { card?: AmtpSignedAgentCard }>(logs)
    expect(printed.regenerated).toBe(true)
    expect(printed.card?.card.name).toBe('Erin New')
    // The re-signed card must verify against the FRESH (post-regenerate) agent key,
    // not a stale signature left over from the pre-regenerate key.
    expect(printed.card && verifyAgentCard(printed.agentPublicKeyPem, printed.card)).toBe(true)
  })

  test('open/close toggle inboundOpen', async () => {
    await captureLogs(() => buildProgram().parseAsync(['register', 'alice'], { from: 'user' }))
    const opened = parseJsonLog<{ handle: string; inboundOpen: boolean }>(
      await captureLogs(() => buildProgram().parseAsync(['open', 'alice'], { from: 'user' }))
    )
    expect(opened.inboundOpen).toBe(true)
    const closed = parseJsonLog<{ handle: string; inboundOpen: boolean }>(
      await captureLogs(() => buildProgram().parseAsync(['close', 'alice'], { from: 'user' }))
    )
    expect(closed.inboundOpen).toBe(false)
  })
})
