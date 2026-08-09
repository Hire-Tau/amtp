import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LaunchdManager, launchdLabel, renderPlist, serveLogPath } from './launchd'
import type { RunResult, Runner, ServiceContext } from './types'

const ctx: ServiceContext = {
  home: '/tmp/amtp-a',
  name: 'amtp-amtp-a-3f9c2b',
  execStart: ['/usr/local/bin/amtp', 'serve'],
}

describe('launchdLabel', () => {
  test('prefixes com.amtp', () => {
    expect(launchdLabel('amtp')).toBe('com.amtp.amtp')
  })
})

describe('renderPlist', () => {
  test('contains label, ProgramArguments, AMTP_HOME, keepalive, and log paths', () => {
    const plist = renderPlist(ctx)
    expect(plist).toContain('<string>com.amtp.amtp-amtp-a-3f9c2b</string>')
    expect(plist).toContain('<string>/usr/local/bin/amtp</string>')
    expect(plist).toContain('<string>serve</string>')
    expect(plist).toContain('<key>AMTP_HOME</key>')
    expect(plist).toContain('<string>/tmp/amtp-a</string>')
    expect(plist).toContain('<key>RunAtLoad</key>')
    expect(plist).toContain('<key>KeepAlive</key>')
    expect(plist).toContain(`<string>${serveLogPath(ctx.home)}</string>`)
  })

  test('never bakes host/port flags in', () => {
    expect(renderPlist(ctx)).not.toContain('--port')
    expect(renderPlist(ctx)).not.toContain('--host')
  })

  test('XML-escapes paths', () => {
    const plist = renderPlist({ ...ctx, home: '/tmp/a&b' })
    expect(plist).toContain('/tmp/a&amp;b')
    expect(plist).not.toContain('<string>/tmp/a&b</string>')
  })
})

describe('LaunchdManager', () => {
  let workDir: string
  let home: string
  let agentsDir: string
  let calls: string[][]

  const okRunner: Runner = async (cmd) => {
    calls.push(cmd)
    return { exitCode: 0, stdout: '', stderr: '' }
  }

  function manager(runner: Runner = okRunner): LaunchdManager {
    return new LaunchdManager({
      ctx: { home, name: 'amtp-h-abc123', execStart: ['/bin/amtp', 'serve'] },
      runner,
      uid: 501,
      launchAgentsDir: agentsDir,
    })
  }

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'amtp-launchd-test-'))
    home = join(workDir, 'home')
    agentsDir = join(workDir, 'LaunchAgents')
    calls = []
  })

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true })
  })

  test('install writes the plist, creates logs dir, boots out then bootstraps', async () => {
    const m = manager()
    const result = await m.install()
    expect(result.warnings).toEqual([])
    expect(readFileSync(m.unitPath(), 'utf8')).toContain('com.amtp.amtp-h-abc123')
    expect(existsSync(join(home, 'logs'))).toBe(true)
    expect(calls).toEqual([
      ['launchctl', 'bootout', 'gui/501', m.unitPath()],
      ['launchctl', 'bootstrap', 'gui/501', m.unitPath()],
    ])
  })

  test('install still succeeds when the pre-bootout fails (first install)', async () => {
    const runner: Runner = async (cmd) => {
      calls.push(cmd)
      if (cmd[1] === 'bootout') return { exitCode: 3, stdout: '', stderr: 'not loaded' }
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    await manager(runner).install() // must not throw
  })

  test('install throws when bootstrap fails', async () => {
    const runner: Runner = async (cmd) => {
      calls.push(cmd)
      if (cmd[1] === 'bootstrap') return { exitCode: 5, stdout: '', stderr: 'nope' }
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    expect(manager(runner).install()).rejects.toThrow('launchctl bootstrap')
  })

  test('uninstall removes the plist and returns true; false when never installed', async () => {
    const m = manager()
    expect(await m.uninstall()).toBe(false)
    await m.install()
    expect(await m.uninstall()).toBe(true)
    expect(existsSync(m.unitPath())).toBe(false)
  })

  test('start/stop/restart require an installed unit', async () => {
    const m = manager()
    expect(m.start()).rejects.toThrow('amtp service install')
    expect(m.stop()).rejects.toThrow('amtp service install')
    expect(m.restart()).rejects.toThrow('amtp service install')
  })

  test('stop targets the service, not the whole domain', async () => {
    const m = manager()
    await m.install()
    calls = []
    await m.stop()
    expect(calls).toEqual([['launchctl', 'bootout', 'gui/501/com.amtp.amtp-h-abc123']])
  })

  test('status parses the pid out of launchctl print', async () => {
    const printOut: RunResult = {
      exitCode: 0,
      stdout: 'com.amtp.amtp-h-abc123 = {\n\tactive count = 1\n\tpid = 4242\n\tstate = running\n}',
      stderr: '',
    }
    const runner: Runner = async (cmd) => {
      calls.push(cmd)
      return cmd[1] === 'print' ? printOut : { exitCode: 0, stdout: '', stderr: '' }
    }
    const m = manager(runner)
    await m.install()
    const status = await m.status()
    expect(status).toMatchObject({ installed: true, running: true, pid: 4242, name: 'amtp-h-abc123' })
  })

  test('status of an uninstalled service never shells out', async () => {
    const status = await manager().status()
    expect(status).toMatchObject({ installed: false, running: false, pid: null })
    expect(calls).toEqual([])
  })

  test('logsCommand tails the home log file', () => {
    const m = manager()
    expect(m.logsCommand({ follow: false, lines: 50 })).toEqual(['tail', '-n', '50', serveLogPath(home)])
    expect(m.logsCommand({ follow: true, lines: 10 })).toEqual(['tail', '-n', '10', '-f', serveLogPath(home)])
  })
})
