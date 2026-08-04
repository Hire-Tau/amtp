// bun:sqlite open + PRAGMA + migration logic.
//
// Spec: docs/superpowers/specs/2026-07-08-amtp-node-design.md §3.3.

import { Database } from 'bun:sqlite'
import { migrations as defaultMigrations } from './schema'

/**
 * Open (creating if necessary) the amtp sqlite db at `path`, applying the
 * durability PRAGMAs and running any pending migrations.
 *
 * `migrationsOverride` defaults to the real migration list from schema.ts;
 * tests may supply a synthetic list to exercise the "apply missing tail"
 * path without depending on future real migrations existing.
 */
export function openDb(path: string, migrationsOverride: string[] = defaultMigrations): Database {
  const db = new Database(path, { create: true })

  // Applied on every open (spec §3.3).
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA synchronous = FULL;')
  db.exec('PRAGMA busy_timeout = 5000;')
  db.exec('PRAGMA foreign_keys = ON;')

  migrate(db, migrationsOverride)

  return db
}

function migrate(db: Database, migrations: string[]): void {
  const { user_version: userVersion } = db.query('PRAGMA user_version').get() as {
    user_version: number
  }

  if (userVersion > migrations.length) {
    throw new Error(
      `database was created by a newer version of amtp (db user_version=${userVersion}, ` +
        `this amtp knows ${migrations.length} migration(s))`
    )
  }

  if (userVersion === migrations.length) {
    // Already fully migrated — nothing to do.
    return
  }

  if (userVersion === 0) {
    // Fresh db: apply every migration inside a single transaction, then set
    // user_version to the final version.
    const applyAll = db.transaction(() => {
      for (const sql of migrations) {
        db.exec(sql)
      }
      db.exec(`PRAGMA user_version = ${migrations.length}`)
    })
    applyAll()
    return
  }

  // Partially migrated: apply the missing tail, one migration per
  // transaction, bumping user_version inside each.
  for (let i = userVersion; i < migrations.length; i++) {
    const version = i + 1
    const applyOne = db.transaction(() => {
      db.exec(migrations[i])
      db.exec(`PRAGMA user_version = ${version}`)
    })
    applyOne()
  }
}
