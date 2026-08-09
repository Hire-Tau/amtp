import { describe, expect, test } from 'bun:test'
import { manualServeHint, realRunner, runOrThrow } from './run'
import type { Runner } from './types'

describe('realRunner', () => {
  test('captures exit code, stdout, and stderr', async () => {
    const res = await realRunner(['sh', '-c', 'echo out; echo err >&2; exit 3'])
    expect(res.exitCode).toBe(3)
    expect(res.stdout).toBe('out\n')
    expect(res.stderr).toBe('err\n')
  })

  test('missing executable becomes exit 127, not a throw', async () => {
    const res = await realRunner(['amtp-definitely-not-a-real-command-xyz'])
    expect(res.exitCode).toBe(127)
    expect(res.stderr).not.toBe('')
  })
})

describe('runOrThrow', () => {
  const failing =
    (exitCode: number): Runner =>
    async () => ({ exitCode, stdout: '', stderr: 'boom' })

  test('returns the result on exit 0', async () => {
    const ok: Runner = async () => ({ exitCode: 0, stdout: 'fine', stderr: '' })
    const res = await runOrThrow(ok, ['systemctl', '--user', 'daemon-reload'])
    expect(res.stdout).toBe('fine')
  })

  test('throws a readable error including the command and stderr', async () => {
    expect(runOrThrow(failing(1), ['launchctl', 'bootstrap'])).rejects.toThrow(
      '`launchctl bootstrap` failed (exit 1): boom'
    )
  })

  test('appends the 127 hint only on exit 127', async () => {
    expect(runOrThrow(failing(127), ['systemctl'], 'run it yourself')).rejects.toThrow('run it yourself')
    expect(runOrThrow(failing(1), ['systemctl'], 'run it yourself')).rejects.not.toThrow('run it yourself')
  })
})

describe('manualServeHint', () => {
  test('spells out the env + command', () => {
    expect(
      manualServeHint({ home: '/tmp/h', name: 'amtp-h-abc123', execStart: ['/usr/local/bin/amtp', 'serve'] })
    ).toBe('run the server under your own supervisor: AMTP_HOME=/tmp/h /usr/local/bin/amtp serve')
  })
})
