import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SystemdManager, renderUnit, systemdUnitName } from './systemd'
import type { Runner, ServiceContext } from './types'

const ctx: ServiceContext = {
  home: '/tmp/amtp-a',
  name: 'amtp-amtp-a-3f9c2b',
  execStart: ['/usr/local/bin/amtp', 'serve'],
}

describe('systemdUnitName', () => {
  test('appends .service', () => {
    expect(systemdUnitName('amtp')).toBe('amtp.service')
  })
})

describe('renderUnit', () => {
  test('contains ExecStart, AMTP_HOME, restart policy, and install target', () => {
    const unit = renderUnit(ctx)
    expect(unit).toContain('ExecStart="/usr/local/bin/amtp" "serve"')
    expect(unit).toContain('Environment="AMTP_HOME=/tmp/amtp-a"')
    expect(unit).toContain('Restart=on-failure')
    expect(unit).toContain('WantedBy=default.target')
  })

  test('never bakes host/port flags in', () => {
    expect(renderUnit(ctx)).not.toContain('--port')
    expect(renderUnit(ctx)).not.toContain('--host')
  })

  test('quotes paths with spaces and escapes embedded quotes', () => {
    const unit = renderUnit({ ...ctx, home: '/tmp/my home', execStart: ['/opt/my tools/amtp', 'serve'] })
    expect(unit).toContain('ExecStart="/opt/my tools/amtp" "serve"')
    expect(unit).toContain('Environment="AMTP_HOME=/tmp/my home"')
    const quoted = renderUnit({ ...ctx, execStart: ['/tmp/a"b', 'serve'] })
    expect(quoted).toContain('ExecStart="/tmp/a\\"b" "serve"')
  })
})

describe('SystemdManager', () => {
  let workDir: string
  let home: string
  let unitDir: string
  let calls: string[][]

  const okRunner: Runner = async (cmd) => {
    calls.push(cmd)
    return { exitCode: 0, stdout: '', stderr: '' }
  }

  function manager(runner: Runner = okRunner): SystemdManager {
    return new SystemdManager({
      ctx: { home, name: 'amtp-h-abc123', execStart: ['/bin/amtp', 'serve'] },
      runner,
      unitDir,
    })
  }

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'amtp-systemd-test-'))
    home = join(workDir, 'home')
    unitDir = join(workDir, 'systemd-user')
    calls = []
  })

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true })
  })

  test('install writes the unit, reloads, enables --now, enables linger', async () => {
    const m = manager()
    const result = await m.install()
    expect(result.warnings).toEqual([])
    expect(readFileSync(m.unitPath(), 'utf8')).toContain('ExecStart="/bin/amtp" "serve"')
    expect(calls).toEqual([
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'enable', '--now', 'amtp-h-abc123.service'],
      ['loginctl', 'enable-linger'],
    ])
  })

  test('linger failure is a warning, not an error', async () => {
    const runner: Runner = async (cmd) => {
      calls.push(cmd)
      if (cmd[0] === 'loginctl') return { exitCode: 1, stdout: '', stderr: 'denied' }
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    const result = await manager(runner).install()
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('enable-linger')
    expect(result.warnings[0]).toContain('log out')
  })

  test('install without systemctl (exit 127) throws with the manual hint', async () => {
    const runner: Runner = async (cmd) => {
      calls.push(cmd)
      return cmd[0] === 'systemctl'
        ? { exitCode: 127, stdout: '', stderr: 'command not found' }
        : { exitCode: 0, stdout: '', stderr: '' }
    }
    expect(manager(runner).install()).rejects.toThrow('under your own supervisor')
  })

  test('uninstall disables, removes the unit, reloads; no-op when never installed', async () => {
    const m = manager()
    expect(await m.uninstall()).toBe(false)
    await m.install()
    calls = []
    expect(await m.uninstall()).toBe(true)
    expect(existsSync(m.unitPath())).toBe(false)
    expect(calls).toEqual([
      ['systemctl', '--user', 'disable', '--now', 'amtp-h-abc123.service'],
      ['systemctl', '--user', 'daemon-reload'],
    ])
  })

  test('start/stop/restart map to systemctl --user and require an installed unit', async () => {
    const m = manager()
    expect(m.start()).rejects.toThrow('amtp service install')
    await m.install()
    calls = []
    await m.start()
    await m.stop()
    await m.restart()
    expect(calls).toEqual([
      ['systemctl', '--user', 'start', 'amtp-h-abc123.service'],
      ['systemctl', '--user', 'stop', 'amtp-h-abc123.service'],
      ['systemctl', '--user', 'restart', 'amtp-h-abc123.service'],
    ])
  })

  test('status parses ActiveState and MainPID from systemctl show', async () => {
    const runner: Runner = async (cmd) => {
      calls.push(cmd)
      if (cmd[2] === 'show') return { exitCode: 0, stdout: 'ActiveState=active\nMainPID=4242\n', stderr: '' }
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    const m = manager(runner)
    await m.install()
    const status = await m.status()
    expect(status).toMatchObject({ installed: true, running: true, pid: 4242 })
  })

  test('status treats MainPID=0 / inactive as not running', async () => {
    const runner: Runner = async (cmd) => {
      calls.push(cmd)
      if (cmd[2] === 'show') return { exitCode: 0, stdout: 'ActiveState=inactive\nMainPID=0\n', stderr: '' }
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    const m = manager(runner)
    await m.install()
    const status = await m.status()
    expect(status).toMatchObject({ installed: true, running: false, pid: null })
  })

  test('logsCommand uses journalctl --user', () => {
    const m = manager()
    expect(m.logsCommand({ follow: false, lines: 50 })).toEqual([
      'journalctl',
      '--user',
      '-u',
      'amtp-h-abc123.service',
      '-n',
      '50',
    ])
    expect(m.logsCommand({ follow: true, lines: 10 })).toEqual([
      'journalctl',
      '--user',
      '-u',
      'amtp-h-abc123.service',
      '-n',
      '10',
      '-f',
    ])
  })
})
