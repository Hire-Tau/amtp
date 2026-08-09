import { describe, expect, test } from 'bun:test'
import { resolveServeCommand } from './exec-resolve'

describe('resolveServeCommand', () => {
  test('compiled binary: execPath IS amtp', () => {
    expect(resolveServeCommand({ execPath: '/usr/local/bin/amtp', scriptPath: undefined })).toEqual([
      '/usr/local/bin/amtp',
      'serve',
    ])
  })

  test('bun shim (npm install): execPath is bun, script is the entrypoint', () => {
    expect(
      resolveServeCommand({ execPath: '/opt/homebrew/bin/bun', scriptPath: '/g/amtp-node/bin/amtp.js' })
    ).toEqual(['/opt/homebrew/bin/bun', '/g/amtp-node/bin/amtp.js', 'serve'])
  })

  test('bun with no script path is an error pointing at --bin', () => {
    expect(() => resolveServeCommand({ execPath: '/usr/bin/bun', scriptPath: undefined })).toThrow('--bin')
  })

  test('--bin override wins and is made absolute', () => {
    const cmd = resolveServeCommand({
      execPath: '/usr/bin/bun',
      scriptPath: '/g/bin/amtp.js',
      binOverride: 'dist/amtp',
    })
    expect(cmd).toHaveLength(2)
    expect(cmd[0].endsWith('/dist/amtp')).toBe(true)
    expect(cmd[0].startsWith('/')).toBe(true)
    expect(cmd[1]).toBe('serve')
  })

  test('relative script paths are made absolute', () => {
    const cmd = resolveServeCommand({ execPath: '/usr/bin/bun', scriptPath: 'bin/amtp.js' })
    expect(cmd[1].startsWith('/')).toBe(true)
    expect(cmd[1].endsWith('/bin/amtp.js')).toBe(true)
  })
})
