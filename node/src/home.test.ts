import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { blobsDir, blobsTmpDir, configPath, dbPath, ensureAmtpDirs, resolveAmtpHome } from './home'

describe('resolveAmtpHome', () => {
  const originalEnv = process.env.AMTP_HOME

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.AMTP_HOME
    else process.env.AMTP_HOME = originalEnv
  })

  test('defaults to ~/.amtp when no override and no env var are set', () => {
    delete process.env.AMTP_HOME
    const home = resolveAmtpHome()
    expect(home).toBe(join(homedir(), '.amtp'))
  })

  test('falls back to the AMTP_HOME env var when no override is given', () => {
    process.env.AMTP_HOME = '/tmp/amtp-from-env'
    expect(resolveAmtpHome()).toBe('/tmp/amtp-from-env')
  })

  test('an explicit override takes precedence over the AMTP_HOME env var', () => {
    process.env.AMTP_HOME = '/tmp/amtp-from-env'
    expect(resolveAmtpHome('/tmp/amtp-from-override')).toBe('/tmp/amtp-from-override')
  })

  test('an explicit override takes precedence with no env var set either', () => {
    delete process.env.AMTP_HOME
    expect(resolveAmtpHome('/tmp/amtp-from-override')).toBe('/tmp/amtp-from-override')
  })
})

describe('path helpers', () => {
  test('join the file-layout names onto the resolved home (spec §3.2)', () => {
    const home = '/tmp/some-amtp-home'
    expect(dbPath(home)).toBe(join(home, 'amtp.db'))
    expect(blobsDir(home)).toBe(join(home, 'blobs'))
    expect(blobsTmpDir(home)).toBe(join(home, 'blobs', 'tmp'))
    expect(configPath(home)).toBe(join(home, 'config.json'))
  })
})

describe('ensureAmtpDirs', () => {
  test('creates blobs/tmp/ (and its parents) under a fresh home', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'amtp-home-test-'))
    try {
      const home = join(tmp, 'home')
      expect(existsSync(blobsTmpDir(home))).toBe(false)

      ensureAmtpDirs(home)

      expect(existsSync(blobsTmpDir(home))).toBe(true)
      expect(existsSync(blobsDir(home))).toBe(true)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
