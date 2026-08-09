import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from './open'
import { migrations as realMigrations } from './schema'

function tempDbPath(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'amtp-db-test-'))
  return { dir, path: join(dir, 'amtp.db') }
}

function userVersion(db: ReturnType<typeof openDb>): number {
  return (db.query('PRAGMA user_version').get() as { user_version: number }).user_version
}

describe('openDb migrations', () => {
  test('opening a fresh db twice yields the same user_version, no errors, no duplicate tables', () => {
    const { dir, path } = tempDbPath()
    try {
      const db1 = openDb(path)
      const v1 = userVersion(db1)
      db1.close()

      const db2 = openDb(path)
      const v2 = userVersion(db2)

      expect(v1).toBe(realMigrations.length)
      expect(v2).toBe(realMigrations.length)

      const identityTables = db2
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'identity'")
        .all()
      expect(identityTables.length).toBe(1)
      db2.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('refuses to open a db created by a newer amtp', () => {
    const { dir, path } = tempDbPath()
    try {
      const db = openDb(path)
      db.exec(`PRAGMA user_version = ${realMigrations.length + 1}`)
      db.close()

      expect(() => openDb(path)).toThrow(/newer version of amtp/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('applies the missing migration tail one migration per transaction, without re-running earlier ones', () => {
    const { dir, path } = tempDbPath()
    try {
      // Open with only migration 1 applied (the real one), simulating a db
      // that predates a hypothetical migration 2.
      const db1 = openDb(path, [realMigrations[0]])
      expect(userVersion(db1)).toBe(1)
      db1.close()

      // Reopen with a synthetic 2-migration array. If migration 1 were
      // re-run here, this would throw ("table identity already exists").
      const migration2 = 'CREATE TABLE amtp_test_marker (id INTEGER PRIMARY KEY);'
      const db2 = openDb(path, [realMigrations[0], migration2])

      expect(userVersion(db2)).toBe(2)

      const markerTables = db2
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'amtp_test_marker'")
        .all()
      expect(markerTables.length).toBe(1)
      db2.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a real v1 database (card_json column absent) upgrades cleanly to the real v2 via the tail loop', () => {
    const { dir, path } = tempDbPath()
    try {
      // Build a db with ONLY migration 1 applied — no card_json column yet.
      const db1 = openDb(path, [realMigrations[0]])
      expect(userVersion(db1)).toBe(1)
      const columnsBefore = db1.query('PRAGMA table_info(registrations)').all() as { name: string }[]
      expect(columnsBefore.some((c) => c.name === 'card_json')).toBe(false)
      db1.close()

      // Reopen with the real, full migration list.
      const db2 = openDb(path, realMigrations)
      expect(userVersion(db2)).toBe(realMigrations.length)
      const columnsAfter = db2.query('PRAGMA table_info(registrations)').all() as { name: string }[]
      expect(columnsAfter.some((c) => c.name === 'card_json')).toBe(true)
      db2.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a real v2 database upgrades to v3 with a nullable legacy signed path prefix', () => {
    const { dir, path } = tempDbPath()
    try {
      const db2 = openDb(path, realMigrations.slice(0, 2))
      db2.run("INSERT INTO peers (instance_id, alias, base_url, public_key_pem, status, created_at) VALUES ('peer', 'peer', 'https://peer', 'pem', 'active', 1)")
      expect(userVersion(db2)).toBe(2)
      db2.close()

      const db3 = openDb(path, realMigrations)
      expect(userVersion(db3)).toBe(3)
      const columns = db3.query('PRAGMA table_info(peers)').all() as { name: string }[]
      expect(columns.some((column) => column.name === 'legacy_signed_get_path_prefix')).toBe(true)
      const row = db3.query("SELECT legacy_signed_get_path_prefix AS prefix FROM peers WHERE instance_id = 'peer'").get() as { prefix: string | null }
      expect(row.prefix).toBeNull()
      db3.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('fresh schema includes legacy_signed_get_path_prefix', () => {
    const { dir, path } = tempDbPath()
    try {
      const db = openDb(path)
      const columns = db.query('PRAGMA table_info(peers)').all() as { name: string }[]
      expect(columns.some((column) => column.name === 'legacy_signed_get_path_prefix')).toBe(true)
      db.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

})
