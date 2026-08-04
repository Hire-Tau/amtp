import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setCliHome } from '../context'
import { runInit } from '../ops/init'
import type { DownloadResult, UploadResult } from '../ops/attach'
import { setOutputOptions } from '../output'
import { registerAttachCommands } from './attach'
import { captureLogs, newProgram, parseJsonLog } from './test-helpers'

let workDir: string
let home: string

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'amtp-attach-cmd-test-'))
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
  registerAttachCommands(program)
  return program
}

describe('amtp attach upload/download', () => {
  test('is registered with the expected shape', () => {
    const program = buildProgram()
    const attach = program.commands.find((c) => c.name() === 'attach')
    expect(attach?.commands.map((c) => c.name())).toEqual(['upload', 'download'])
  })

  test('upload then download round-trips the file contents', async () => {
    const filePath = join(workDir, 'note.txt')
    writeFileSync(filePath, 'round trip bytes')

    const uploadLogs = await captureLogs(() =>
      buildProgram().parseAsync(['attach', 'upload', filePath], { from: 'user' })
    )
    const uploaded = parseJsonLog<UploadResult>(uploadLogs)
    expect(uploaded.filename).toBe('note.txt')

    const dest = join(workDir, 'downloaded.txt')
    const downloadLogs = await captureLogs(() =>
      buildProgram().parseAsync(['attach', 'download', uploaded.attachmentId, '-o', dest], { from: 'user' })
    )
    const downloaded = parseJsonLog<DownloadResult>(downloadLogs)
    expect(downloaded.path).toBe(dest)
    expect(existsSync(dest)).toBe(true)
    expect(readFileSync(dest, 'utf8')).toBe('round trip bytes')
    expect(downloaded.sha256).toBe(uploaded.sha256)
  })
})
