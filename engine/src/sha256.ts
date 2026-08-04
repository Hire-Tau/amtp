import { createHash } from 'node:crypto'

// Mirrors services/inbox/attachment-storage.ts:26-28.
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}
