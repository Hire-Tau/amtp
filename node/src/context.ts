// Tiny module-level CLI context: the resolved AMTP_HOME for the current
// invocation, set once by index.ts's root `preAction` hook and read by every
// command action — mirrors apps/cli's setOutputOptions/setSelectedBackend
// pattern (apps/cli/src/output.ts, apps/cli/src/config.ts) so nested
// subcommands don't need `home` threaded through every action signature.
//
// Spec: docs/superpowers/specs/2026-07-08-amtp-node-design.md §3.2, §5.4.

import { existsSync } from 'node:fs'
import type { Database } from 'bun:sqlite'
import { openDb } from './db/open'
import { dbPath, resolveAmtpHome } from './home'

let currentHome: string | undefined

/** Set by the root command's `preAction` hook once options are parsed. */
export function setCliHome(home: string): void {
  currentHome = home
}

/** Falls back to `resolveAmtpHome()` (env/default) if called outside a parsed command — e.g. directly from a test. */
export function getCliHome(): string {
  return currentHome ?? resolveAmtpHome()
}

/**
 * Open the db for a one-shot verb. Every command other than `amtp init`
 * fails loudly with a pointer to `amtp init` when `amtp.db` is missing
 * (spec §3.2).
 */
export function openHomeDb(home: string): Database {
  if (!existsSync(dbPath(home))) {
    throw new Error(`amtp home not initialized at ${home} — run "amtp init" first`)
  }
  return openDb(dbPath(home))
}
