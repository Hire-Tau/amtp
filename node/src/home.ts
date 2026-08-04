// AMTP_HOME resolution + on-disk file layout helpers.
//
// Spec: docs/superpowers/specs/2026-07-08-amtp-node-design.md §3.2.
//
//   $AMTP_HOME/                 default ~/.amtp; overridable by --home flag > AMTP_HOME env
//     amtp.db                   the sqlite database (+ -wal/-shm siblings)
//     blobs/                    attachment blobs, flat, named by attachments.id
//       <attachment-uuid>
//       tmp/                    staging for atomic writes
//     config.json               serve/policy config; created by `amtp init`
//
// `amtp init` (a later task) is responsible for creating the home directory
// with 0700 permissions and the db file with 0600 permissions, and for
// writing config.json. This module only resolves the path and ensures the
// blobs/tmp staging directory exists (needed by the durable blob writer in
// src/blobs.ts), so tests never have to hand-roll `mkdirSync` calls.

import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Resolve $AMTP_HOME. Precedence: explicit `override` param (e.g. a future
 * `--home` CLI flag) > `AMTP_HOME` env var > default `~/.amtp`.
 */
export function resolveAmtpHome(override?: string): string {
  if (override) return override
  if (process.env.AMTP_HOME) return process.env.AMTP_HOME
  return join(homedir(), '.amtp')
}

/** Path to the sqlite database file inside a resolved AMTP_HOME. */
export function dbPath(home: string): string {
  return join(home, 'amtp.db')
}

/** Path to the blobs directory inside a resolved AMTP_HOME. */
export function blobsDir(home: string): string {
  return join(home, 'blobs')
}

/** Path to the blobs staging directory used by durable atomic writes. */
export function blobsTmpDir(home: string): string {
  return join(home, 'blobs', 'tmp')
}

/** Path to config.json inside a resolved AMTP_HOME. */
export function configPath(home: string): string {
  return join(home, 'config.json')
}

/**
 * Ensure the on-disk directory layout exists under `home`
 * (`blobs/tmp/`, which also implies `blobs/` and `home` itself). Does NOT
 * create amtp.db or config.json — those are `amtp init`'s job.
 */
export function ensureAmtpDirs(home: string): void {
  mkdirSync(blobsTmpDir(home), { recursive: true })
}
