// §4.6 `attachments` (AttachmentStore).
//
// Spec: docs/superpowers/specs/2026-07-08-amtp-node-design.md §4.6.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Database } from 'bun:sqlite'
import type { AttachmentStore } from 'amtp-engine'
import { blobsDir } from '../home'

interface AttachmentBlobRow {
  filename: string
  content_type: string
  byte_size: number
  storage_path: string
}

export function buildAttachmentStore(db: Database, home: string): AttachmentStore {
  return {
    async totalStoredBytes() {
      const row = db
        .query<
          { total: number },
          []
        >("SELECT COALESCE(SUM(byte_size), 0) AS total FROM attachments WHERE direction = 'in'")
        .get()
      return row ? row.total : 0
    },

    async readOutboundBlob(attachmentId) {
      let row: AttachmentBlobRow | null
      try {
        row = db
          .query<
            AttachmentBlobRow,
            [string]
          >("SELECT filename, content_type, byte_size, storage_path FROM attachments WHERE id = ? AND direction='out'")
          .get(attachmentId)
      } catch {
        // Malformed id (or any other query failure) — uniform not-found (port
        // contract: never throw).
        return null
      }
      if (!row) return null

      try {
        const bytes = await readFile(join(blobsDir(home), row.storage_path))
        return { bytes: new Uint8Array(bytes), contentType: row.content_type, byteSize: row.byte_size }
      } catch {
        return null
      }
    },
  }
}
