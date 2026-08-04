// Durable attachment blob writes.
//
// Spec: docs/superpowers/specs/2026-07-08-amtp-node-design.md §3.3
// "Blob writes are write-then-rename-then-dirsync-then-commit".
//
// This lives outside src/db/ because it never touches sqlite directly — it
// is purely about the blobs/ directory on disk. The sqlite-transaction-commit
// step that follows a blob write (step 4 of §3.3) is wired into the
// attachment adapter in a later task; this module only implements the
// file-durability primitive itself (steps 1-3).

import { closeSync, fsyncSync, openSync, renameSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { blobsDir, blobsTmpDir, ensureAmtpDirs } from './home'

/**
 * Durably write `data` to `<home>/blobs/<finalId>`.
 *
 * Sequence (normative, spec §3.3):
 *   1. write bytes to `blobs/tmp/<uuid>` and fsync the FILE via a node:fs fd
 *      (openSync + writeSync + fsyncSync + closeSync — NOT Bun.file(), whose
 *      writer() flush/end does not guarantee an fsync),
 *   2. renameSync to `blobs/<finalId>` (atomic on POSIX; `finalId` is always
 *      a freshly minted local UUID, so this can never replace an existing
 *      blob),
 *   3. open `blobs/` itself and fsyncSync the DIRECTORY fd so the rename's
 *      directory entry is durable, then close it.
 *
 * `finalId` is supplied by the caller (a later task's attachment adapter
 * code, which always mints a fresh local UUID per spec §4.9) — this helper
 * just accepts it as a parameter.
 */
export function writeBlobDurable(home: string, finalId: string, data: Uint8Array | Buffer): void {
  ensureAmtpDirs(home)

  const tmpPath = join(blobsTmpDir(home), crypto.randomUUID())
  const finalPath = join(blobsDir(home), finalId)

  // 1. Write + fsync the staged file via its fd.
  const fileFd = openSync(tmpPath, 'w')
  try {
    writeSync(fileFd, data)
    fsyncSync(fileFd)
  } finally {
    closeSync(fileFd)
  }

  // 2. Atomically rename into place.
  renameSync(tmpPath, finalPath)

  // 3. fsync the containing directory so the rename's directory entry is
  // durable.
  const dirFd = openSync(blobsDir(home), 'r')
  try {
    fsyncSync(dirFd)
  } finally {
    closeSync(dirFd)
  }
}
