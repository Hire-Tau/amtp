import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'bun:sqlite'
import { openDb } from '../db/open'
import { dbPath, ensureAmtpDirs } from '../home'
import { downloadAttachment, uploadAttachment } from './attach'

let workDir: string
let home: string
let db: Database

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'amtp-attach-test-'))
  home = join(workDir, 'home')
  ensureAmtpDirs(home)
  db = openDb(dbPath(home))
})

afterEach(() => {
  db.close()
  rmSync(workDir, { recursive: true, force: true })
})

describe('uploadAttachment', () => {
  test('stages a direction=out row with a fresh id and computes sha256/byteSize', () => {
    const filePath = join(workDir, 'note.txt')
    writeFileSync(filePath, 'hello attachment')

    const result = uploadAttachment(db, home, filePath)

    expect(result.filename).toBe('note.txt')
    expect(result.contentType).toBe('application/octet-stream')
    expect(result.byteSize).toBe(Buffer.byteLength('hello attachment'))
    expect(result.sha256).toBe(createHash('sha256').update('hello attachment').digest('hex'))

    const row = db
      .query<
        { direction: string; message_id: string | null; storage_path: string },
        [string]
      >('SELECT direction, message_id, storage_path FROM attachments WHERE id = ?')
      .get(result.attachmentId)
    expect(row?.direction).toBe('out')
    expect(row?.message_id).toBeNull()
    // The blob is durably written at <home>/blobs/<localId> (storage_path === id for direction='out').
    expect(row?.storage_path).toBe(result.attachmentId)
    expect(existsSync(join(home, 'blobs', result.attachmentId))).toBe(true)
  })

  test('honors --content-type and --filename overrides', () => {
    const filePath = join(workDir, 'raw-bytes')
    writeFileSync(filePath, 'x')
    const result = uploadAttachment(db, home, filePath, { contentType: 'text/plain', filename: 'renamed.txt' })
    expect(result.contentType).toBe('text/plain')
    expect(result.filename).toBe('renamed.txt')
  })
})

describe('downloadAttachment', () => {
  test('copies the stored blob to cwd (default) named after the stored filename', () => {
    const filePath = join(workDir, 'note.txt')
    writeFileSync(filePath, 'payload bytes')
    const staged = uploadAttachment(db, home, filePath)

    const cwdDir = join(workDir, 'cwd')
    mkdirSync(cwdDir)
    const originalCwd = process.cwd()
    process.chdir(cwdDir)
    try {
      const result = downloadAttachment(db, home, staged.attachmentId)
      // Compare against a freshly-resolved cwd, not the pre-chdir `cwdDir` string — on
      // macOS `/tmp` is a symlink to `/private/tmp`, and `process.cwd()` returns the
      // resolved path after chdir.
      expect(result.path).toBe(join(process.cwd(), 'note.txt'))
      expect(readFileSync(result.path, 'utf8')).toBe('payload bytes')
      expect(result.sha256).toBe(staged.sha256)
    } finally {
      process.chdir(originalCwd)
    }
  })

  test('-o <file> writes to an exact destination path', () => {
    const filePath = join(workDir, 'note.txt')
    writeFileSync(filePath, 'payload bytes')
    const staged = uploadAttachment(db, home, filePath)

    const dest = join(workDir, 'exact-dest.bin')
    const result = downloadAttachment(db, home, staged.attachmentId, dest)
    expect(result.path).toBe(dest)
    expect(readFileSync(dest, 'utf8')).toBe('payload bytes')
  })

  test('-o <dir> writes <dir>/<storedFilename>', () => {
    const filePath = join(workDir, 'note.txt')
    writeFileSync(filePath, 'payload bytes')
    const staged = uploadAttachment(db, home, filePath)

    const destDir = join(workDir, 'out-dir')
    mkdirSync(destDir)
    const result = downloadAttachment(db, home, staged.attachmentId, destDir)
    expect(result.path).toBe(join(destDir, 'note.txt'))
  })

  test('throws for an unknown attachment id', () => {
    expect(() => downloadAttachment(db, home, 'ghost')).toThrow(/unknown attachment/)
  })

  // Security regression (defense-in-depth, second layer): even if a hostile
  // filename somehow reached the `attachments` table (hooks.ts sanitizes at
  // receive time, but this layer must not depend on that alone), downloading
  // it must never escape the target directory.
  test('sanitizes a path-traversal filename so the write lands inside the target dir', () => {
    const blobId = 'blob-1'
    writeFileSync(join(home, 'blobs', blobId), 'payload bytes')
    db.run(
      `INSERT INTO attachments (id, message_id, direction, filename, content_type, byte_size, sha256, storage_path, created_at)
       VALUES (?, NULL, 'in', ?, ?, ?, ?, ?, ?)`,
      ['att-1', '../../../../tmp/traversal-probe.txt', 'text/plain', 13, 'x'.repeat(64), blobId, Date.now()]
    )

    const destDir = join(workDir, 'download-target')
    mkdirSync(destDir)
    const result = downloadAttachment(db, home, 'att-1', destDir)

    expect(result.path.startsWith(destDir + '/')).toBe(true)
    expect(result.path).toBe(join(destDir, 'traversal-probe.txt'))
    expect(readFileSync(result.path, 'utf8')).toBe('payload bytes')
    // Nothing was written outside the target dir.
    expect(existsSync('/tmp/traversal-probe.txt')).toBe(false)
  })

  test('sanitizes a path-traversal filename in the default-cwd case too', () => {
    const blobId = 'blob-2'
    writeFileSync(join(home, 'blobs', blobId), 'payload bytes')
    db.run(
      `INSERT INTO attachments (id, message_id, direction, filename, content_type, byte_size, sha256, storage_path, created_at)
       VALUES (?, NULL, 'in', ?, ?, ?, ?, ?, ?)`,
      ['att-2', '../../../../tmp/traversal-probe-2.txt', 'text/plain', 13, 'x'.repeat(64), blobId, Date.now()]
    )

    const cwdDir = join(workDir, 'cwd2')
    mkdirSync(cwdDir)
    const originalCwd = process.cwd()
    process.chdir(cwdDir)
    try {
      const result = downloadAttachment(db, home, 'att-2')
      const resolvedCwd = process.cwd()
      expect(result.path.startsWith(resolvedCwd + '/')).toBe(true)
      expect(result.path).toBe(join(resolvedCwd, 'traversal-probe-2.txt'))
    } finally {
      process.chdir(originalCwd)
    }
    expect(existsSync('/tmp/traversal-probe-2.txt')).toBe(false)
  })
})
