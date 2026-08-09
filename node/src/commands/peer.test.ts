import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateInstanceKeyPair, instanceIdFromPublicKeyPem } from 'amtp-protocol'
import { setCliHome } from '../context'
import { runInit } from '../ops/init'
import type { PeerRow } from '../ops/peers'
import { setOutputOptions } from '../output'
import { registerPeerCommands, resolvePublicKey } from './peer'
import { captureLogs, newProgram, parseJsonLog } from './test-helpers'

let workDir: string
let home: string

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'amtp-peer-cmd-test-'))
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
  registerPeerCommands(program)
  return program
}

describe('resolvePublicKey', () => {
  test('reads a file path', () => {
    const p = join(workDir, 'key.pem')
    writeFileSync(p, 'PEMDATA')
    expect(resolvePublicKey(p)).toBe('PEMDATA')
  })
  test('passes through a literal PEM string', () => {
    expect(resolvePublicKey('-----BEGIN PUBLIC KEY-----')).toBe('-----BEGIN PUBLIC KEY-----')
  })
})

describe('amtp peer add/list/remove', () => {
  test('is registered with the expected shape', () => {
    const program = buildProgram()
    const peer = program.commands.find((c) => c.name() === 'peer')
    expect(peer?.commands.map((c) => c.name())).toEqual(['add', 'list', 'remove'])
  })

  test('add derives the instance id from --public-key', async () => {
    const { publicKeyPem } = generateInstanceKeyPair()
    const expectedId = instanceIdFromPublicKeyPem(publicKeyPem)
    const logs = await captureLogs(() =>
      buildProgram().parseAsync(
        ['peer', 'add', '--alias', 'friend', '--base-url', 'http://peer.example', '--public-key', publicKeyPem],
        { from: 'user' }
      )
    )
    const printed = parseJsonLog<PeerRow>(logs)
    expect(printed.instanceId).toBe(expectedId)
    expect(printed.alias).toBe('friend')
  })

  test('JSON add/list round-trips the legacy signed GET prefix', async () => {
    const { publicKeyPem } = generateInstanceKeyPair()
    const args = ['peer', 'add', '--alias', 'legacy', '--base-url', 'http://peer.example', '--public-key', publicKeyPem, '--legacy-signed-get-path-prefix', '/api']
    const created = parseJsonLog<PeerRow>(await captureLogs(() => buildProgram().parseAsync(args, { from: 'user' })))
    expect(created.legacySignedGetPathPrefix).toBe('/api')
    const listed = parseJsonLog<PeerRow[]>(await captureLogs(() => buildProgram().parseAsync(['peer', 'list'], { from: 'user' })))
    expect(listed[0].legacySignedGetPathPrefix).toBe('/api')
  })

  test('list then remove round-trips through the db', async () => {
    const { publicKeyPem } = generateInstanceKeyPair()
    await captureLogs(() =>
      buildProgram().parseAsync(
        ['peer', 'add', '--alias', 'friend', '--base-url', 'http://peer.example', '--public-key', publicKeyPem],
        { from: 'user' }
      )
    )

    const listLogs = await captureLogs(() => buildProgram().parseAsync(['peer', 'list'], { from: 'user' }))
    expect(parseJsonLog<PeerRow[]>(listLogs)).toHaveLength(1)

    await captureLogs(() => buildProgram().parseAsync(['peer', 'remove', 'friend'], { from: 'user' }))
    const afterRemove = await captureLogs(() => buildProgram().parseAsync(['peer', 'list'], { from: 'user' }))
    expect(parseJsonLog<PeerRow[]>(afterRemove)).toHaveLength(0)
  })
})
