import { describe, expect, test } from 'bun:test'
import { LaunchdManager } from './launchd'
import { createServiceManager } from './manager'
import { SystemdManager } from './systemd'
import type { Runner } from './types'

const silentRunner: Runner = async () => ({ exitCode: 0, stdout: '', stderr: '' })

describe('createServiceManager', () => {
  test('darwin gets the launchd backend', () => {
    const m = createServiceManager({ home: '/tmp/amtp-a', platform: 'darwin', runner: silentRunner })
    expect(m).toBeInstanceOf(LaunchdManager)
    expect(m.name).toMatch(/^amtp-amtp-a-[0-9a-f]{6}$/)
  })

  test('linux gets the systemd backend', () => {
    const m = createServiceManager({ home: '/tmp/amtp-a', platform: 'linux', runner: silentRunner })
    expect(m).toBeInstanceOf(SystemdManager)
  })

  test('unsupported platform throws with the manual-supervision command', () => {
    expect(() =>
      createServiceManager({ home: '/tmp/amtp-a', binOverride: '/usr/local/bin/amtp', platform: 'win32' })
    ).toThrow('AMTP_HOME=/tmp/amtp-a /usr/local/bin/amtp serve')
  })

  test('resolves the home before naming, so relative and absolute agree', () => {
    const abs = createServiceManager({ home: '/tmp/amtp-a', platform: 'darwin', runner: silentRunner })
    const viaDots = createServiceManager({ home: '/tmp/x/../amtp-a', platform: 'darwin', runner: silentRunner })
    expect(viaDots.name).toBe(abs.name)
  })

  test('binOverride flows into the ExecStart', async () => {
    const m = createServiceManager({
      home: '/tmp/amtp-a',
      binOverride: '/opt/amtp',
      platform: 'darwin',
      runner: silentRunner,
    })
    const status = await m.status()
    expect(status.execStart).toEqual(['/opt/amtp', 'serve'])
  })
})
