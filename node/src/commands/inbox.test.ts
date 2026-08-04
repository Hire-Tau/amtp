import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'bun:sqlite'
import { setCliHome } from '../context'
import { openDb } from '../db/open'
import { dbPath, ensureAmtpDirs } from '../home'
import { runInit } from '../ops/init'
import { register } from '../ops/registrations'
import type { FullMessage, MessageSummary } from '../ops/inbox'
import { setOutputOptions } from '../output'
import { registerInboxCommands } from './inbox'
import { captureLogs, newProgram, parseJsonLog } from './test-helpers'

let workDir: string
let home: string
let db: Database
let messageId: string

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'amtp-inbox-cmd-test-'))
  home = join(workDir, 'home')
  ensureAmtpDirs(home)
  setCliHome(home)
  const init = runInit(home)
  db = openDb(dbPath(home))
  register(db, init.instanceId, { handle: 'alice' })

  messageId = randomUUID()
  db.run(
    `INSERT INTO messages (id, kind, handle, from_address, envelope_id, subject, content, received_at)
     VALUES (?, 'received', 'alice', 'amtp://remote/bob', ?, 'hi', 'body text', ?)`,
    [messageId, randomUUID(), Date.now()]
  )
  db.close()
  setOutputOptions({ json: true })
})

afterEach(() => {
  setOutputOptions({})
  rmSync(workDir, { recursive: true, force: true })
})

function buildProgram() {
  const program = newProgram()
  registerInboxCommands(program)
  return program
}

describe('amtp inbox list/read', () => {
  test('is registered with the expected shape', () => {
    const program = buildProgram()
    const inbox = program.commands.find((c) => c.name() === 'inbox')
    expect(inbox?.commands.map((c) => c.name())).toEqual(['list', 'read'])
  })

  test('list shows the seeded message', async () => {
    const logs = await captureLogs(() => buildProgram().parseAsync(['inbox', 'list'], { from: 'user' }))
    const messages = parseJsonLog<Array<Record<string, unknown>>>(logs)
    expect(messages).toHaveLength(1)
    expect(messages[0].id).toBe(messageId)
  })

  test('read prints the full message and marks it read', async () => {
    const readLogs = await captureLogs(() => buildProgram().parseAsync(['inbox', 'read', messageId], { from: 'user' }))
    const message = parseJsonLog<FullMessage>(readLogs)
    expect(message.content).toBe('body text')
    expect(message.read).toBe(true)

    const listLogs = await captureLogs(() => buildProgram().parseAsync(['inbox', 'list', '--unread'], { from: 'user' }))
    expect(parseJsonLog<MessageSummary[]>(listLogs)).toHaveLength(0)
  })
})
