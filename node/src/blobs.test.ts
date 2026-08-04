import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeBlobDurable } from './blobs'
import { blobsDir, blobsTmpDir } from './home'

describe('writeBlobDurable', () => {
  test('lands the file at blobs/<finalId> with the correct bytes, and leaves nothing behind in blobs/tmp/', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'amtp-blob-test-'))
    try {
      const home = join(tmp, 'home')
      const finalId = crypto.randomUUID()
      const data = Buffer.from('hello amtp durable blob')

      writeBlobDurable(home, finalId, data)

      const finalPath = join(blobsDir(home), finalId)
      expect(existsSync(finalPath)).toBe(true)
      expect(readFileSync(finalPath)).toEqual(data)

      // The staging temp file was renamed away, not copied — blobs/tmp/
      // must not retain any leftover file (under any name).
      const tmpEntries = readdirSync(blobsTmpDir(home))
      expect(tmpEntries.length).toBe(0)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
