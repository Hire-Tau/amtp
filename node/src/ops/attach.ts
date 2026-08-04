// `amtp attach upload/download` (spec §7.2): stages an outbound blob
// (`direction='out'`) for use with `send --attach-id`, and copies an
// already-pulled local blob back out to a file.

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Database } from 'bun:sqlite'
import { blobsDir } from '../home'
import { writeBlobDurable } from '../blobs'

/** Strips any directory components from a (possibly hostile) filename; falls
 *  back to `fallback` if that leaves nothing usable (empty or '.'). */
function safeBasename(filename: string, fallback: string): string {
  const name = basename(filename)
  return name === '' || name === '.' ? fallback : name
}

export interface UploadResult {
  attachmentId: string
  filename: string
  contentType: string
  byteSize: number
  sha256: string
}

export function uploadAttachment(
  db: Database,
  home: string,
  filePath: string,
  opts: { filename?: string; contentType?: string } = {}
): UploadResult {
  const bytes = readFileSync(filePath)
  const id = randomUUID()
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const filename = opts.filename ?? basename(filePath)
  const contentType = opts.contentType ?? 'application/octet-stream'

  writeBlobDurable(home, id, bytes)
  db.run(
    `INSERT INTO attachments (id, message_id, direction, filename, content_type, byte_size, sha256, storage_path, created_at)
     VALUES (?, NULL, 'out', ?, ?, ?, ?, ?, ?)`,
    [id, filename, contentType, bytes.length, sha256, id, Date.now()]
  )

  return { attachmentId: id, filename, contentType, byteSize: bytes.length, sha256 }
}

export interface DownloadResult {
  path: string
  filename: string
  contentType: string
  byteSize: number
  sha256: string
}

interface AttachmentBlobRow {
  filename: string
  content_type: string
  byte_size: number
  sha256: string
  storage_path: string
}

/** Local read only — blobs arrive at receive time (AMTP.md §10), never lazily pulled here. */
export function downloadAttachment(db: Database, home: string, attachmentId: string, outPath?: string): DownloadResult {
  const row = db
    .query<
      AttachmentBlobRow,
      [string]
    >('SELECT filename, content_type, byte_size, sha256, storage_path FROM attachments WHERE id = ?')
    .get(attachmentId)
  if (!row) throw new Error(`unknown attachment: ${attachmentId}`)

  const bytes = readFileSync(join(blobsDir(home), row.storage_path))

  // `row.filename` is sender-controlled for received attachments (wire ref,
  // unconstrained by the protocol schema) — never join it into a filesystem
  // path unsanitized (path traversal). `basename` strips any directory
  // components; if that yields nothing usable, fall back to the attachment
  // id so the write still lands inside the intended destination.
  const safeName = safeBasename(row.filename, attachmentId)

  let dest = outPath ?? join(process.cwd(), safeName)
  if (outPath && existsSync(outPath) && statSync(outPath).isDirectory()) {
    dest = join(outPath, safeName)
  }
  writeFileSync(dest, bytes)

  return {
    path: dest,
    filename: row.filename,
    contentType: row.content_type,
    byteSize: row.byte_size,
    sha256: row.sha256,
  }
}
