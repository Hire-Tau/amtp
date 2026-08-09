// Deterministic per-home service naming (spec §"Naming: one service per
// home"): every verb re-derives the same name from the resolved home, so
// `--home` is the only addressing a user ever needs.

import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'

/**
 * "amtp" for the default home (~/.amtp); otherwise
 * `amtp-<sanitized basename>-<first 6 hex of sha256(absolute path)>`.
 */
export function deriveServiceName(home: string): string {
  const abs = resolve(home)
  if (abs === join(homedir(), '.amtp')) return 'amtp'
  const slug =
    basename(abs)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'home'
  const hash6 = createHash('sha256').update(abs).digest('hex').slice(0, 6)
  return `amtp-${slug}-${hash6}`
}
