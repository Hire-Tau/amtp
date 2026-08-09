# `amtp service` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `amtp service install|uninstall|start|stop|restart|status|logs` verb group that registers `amtp serve` as a user-level always-on service (launchd LaunchAgents on macOS, systemd user units on Linux), one service per `$AMTP_HOME`.

**Architecture:** A new `node/src/service/` directory holds pure helpers (name derivation, executable resolution, plist/unit rendering) plus two `ServiceManager` implementations (launchd, systemd) that shell out through an injected `Runner` function so tests never touch the real `launchctl`/`systemctl`. A `createServiceManager` factory picks the backend by platform. `node/src/commands/service.ts` is thin commander wiring following the existing per-command pattern.

**Tech Stack:** Bun (>= 1.2), TypeScript, commander v12, `bun:test`. **No new dependencies.**

**Spec:** `docs/superpowers/specs/2026-08-08-amtp-service-design.md`

## Global Constraints

- All commands run from the `node/` package: tests are `cd node && bun test <file>`, typecheck is `cd node && bun run typecheck`.
- User-level services only — never sudo, never LaunchDaemons or `/etc/systemd/system`.
- The purity gate (`node/src/purity.test.ts`) only allows imports of `node:*`, `bun:*`, relative paths, `commander`, `amtp-protocol`, `amtp-engine`, and `@modelcontextprotocol/sdk`; `bun:test` only in `*.test.ts` files. `Bun.spawn` (a global, not an import) is fine.
- Uninitialized-home error message must exactly match the existing convention from `node/src/context.ts:33`: `` amtp home not initialized at ${home} — run "amtp init" first ``.
- All verbs respect the global `--home <dir>` flag via `getCliHome()` (from `node/src/context.ts`) and global `--json` via `output()`/`outputError()` (from `node/src/output.ts`). Never read `process.env.AMTP_HOME` directly.
- No host/port flags anywhere in units — `$AMTP_HOME/config.json` (`serve.host`/`serve.port`) is the single source of truth.
- Code comments follow the existing style: a short header comment on each file saying what it is, referencing the spec.

---

### Task 1: Shared service types + runner

**Files:**
- Create: `node/src/service/types.ts`
- Create: `node/src/service/run.ts`
- Test: `node/src/service/run.test.ts`

**Interfaces:**
- Consumes: nothing (leaf task).
- Produces (used by every later task):
  - `type Runner = (cmd: string[]) => Promise<RunResult>` with `RunResult = { exitCode: number; stdout: string; stderr: string }`
  - `interface ServiceContext { home: string; name: string; execStart: string[] }`
  - `interface ServiceStatus { installed: boolean; running: boolean; pid: number | null; name: string; unitPath: string; home: string; execStart: string[] }`
  - `interface LogsOptions { follow: boolean; lines: number }`
  - `interface InstallResult { warnings: string[] }`
  - `interface ServiceManager { readonly name: string; unitPath(): string; install(): Promise<InstallResult>; uninstall(): Promise<boolean>; start(): Promise<void>; stop(): Promise<void>; restart(): Promise<void>; status(): Promise<ServiceStatus>; logsCommand(opts: LogsOptions): string[] }`
  - `const realRunner: Runner`
  - `function runOrThrow(runner: Runner, cmd: string[], hint127?: string): Promise<RunResult>`
  - `function manualServeHint(ctx: ServiceContext): string`

- [ ] **Step 1: Write the failing test**

Create `node/src/service/run.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd node && bun test src/service/run.test.ts`
Expected: FAIL — cannot resolve `./run` / `./types`.

- [ ] **Step 3: Write the implementation**

Create `node/src/service/types.ts`:

```ts
// Shared types for `amtp service` (spec:
// docs/superpowers/specs/2026-08-08-amtp-service-design.md). The Runner
// indirection is the testing seam: backends never call launchctl/systemctl
// directly, they call an injected Runner, so verb tests use a recorder.

export interface RunResult {
  exitCode: number
  stdout: string
  stderr: string
}

/** Executes an argv, capturing output. Injected so tests never touch launchctl/systemctl. */
export type Runner = (cmd: string[]) => Promise<RunResult>

/** Everything a backend needs to render and address one home's service. */
export interface ServiceContext {
  /** Resolved absolute AMTP_HOME. */
  home: string
  /** deriveServiceName(home) — e.g. "amtp" or "amtp-amtp-a-3f9c2b". */
  name: string
  /** Absolute program + args, ending in "serve". */
  execStart: string[]
}

export interface ServiceStatus {
  installed: boolean
  running: boolean
  pid: number | null
  name: string
  unitPath: string
  home: string
  execStart: string[]
}

export interface LogsOptions {
  follow: boolean
  lines: number
}

export interface InstallResult {
  /** Non-fatal notices to show the user (e.g. enable-linger failed). */
  warnings: string[]
}

export interface ServiceManager {
  readonly name: string
  unitPath(): string
  /** Write the unit, enable it, start it. Idempotent (reinstall = overwrite + restart). */
  install(): Promise<InstallResult>
  /** Stop + disable + remove the unit. Returns false when nothing was installed (no-op). */
  uninstall(): Promise<boolean>
  start(): Promise<void>
  stop(): Promise<void>
  restart(): Promise<void>
  status(): Promise<ServiceStatus>
  /** The argv the CLI should exec with inherited stdio to show logs. */
  logsCommand(opts: LogsOptions): string[]
}
```

Create `node/src/service/run.ts`:

```ts
// The real Runner (Bun.spawn with captured output) plus the shared
// fail-loudly wrapper. Spawn failures (missing binary — e.g. no systemctl on
// a non-systemd Linux) become exit 127 instead of a throw, so callers can
// attach the manual-supervision hint.

import type { RunResult, Runner, ServiceContext } from './types'

export const realRunner: Runner = async (cmd) => {
  try {
    const proc = Bun.spawn(cmd, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { exitCode, stdout, stderr }
  } catch (error) {
    return { exitCode: 127, stdout: '', stderr: (error as Error).message }
  }
}

/**
 * Run and throw a readable error when the command fails. `hint127` is
 * appended when the tool itself is missing (exit 127) — used to point at
 * manual supervision on platforms without a working service manager.
 */
export async function runOrThrow(runner: Runner, cmd: string[], hint127?: string): Promise<RunResult> {
  const res = await runner(cmd)
  if (res.exitCode !== 0) {
    const detail = (res.stderr || res.stdout).trim()
    const hint = res.exitCode === 127 && hint127 ? ` — ${hint127}` : ''
    throw new Error(`\`${cmd.join(' ')}\` failed (exit ${res.exitCode})${detail ? `: ${detail}` : ''}${hint}`)
  }
  return res
}

/** One-line manual-supervision fallback used by unsupported-platform errors. */
export function manualServeHint(ctx: ServiceContext): string {
  return `run the server under your own supervisor: AMTP_HOME=${ctx.home} ${ctx.execStart.join(' ')}`
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd node && bun test src/service/run.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Typecheck and commit**

```bash
cd node && bun run typecheck
git add src/service/types.ts src/service/run.ts src/service/run.test.ts
git commit -m "feat(service): shared types + Runner seam for amtp service backends"
```

---

### Task 2: Service name derivation

**Files:**
- Create: `node/src/service/name.ts`
- Test: `node/src/service/name.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `function deriveServiceName(home: string): string` — `"amtp"` for the default home (`~/.amtp`), otherwise `` `amtp-${slug}-${hash6}` `` where `slug` is the home basename lowercased with runs of non-`[a-z0-9]` collapsed to `-` (leading/trailing `-` trimmed, empty → `"home"`) and `hash6` is the first 6 hex chars of SHA-256 of the resolved absolute path.

- [ ] **Step 1: Write the failing test**

Create `node/src/service/name.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { deriveServiceName } from './name'

describe('deriveServiceName', () => {
  test('default home is plain "amtp"', () => {
    expect(deriveServiceName(join(homedir(), '.amtp'))).toBe('amtp')
  })

  test('default home given as a non-normalized path still matches', () => {
    expect(deriveServiceName(join(homedir(), 'x', '..', '.amtp'))).toBe('amtp')
  })

  test('non-default home gets amtp-<basename>-<hash6>', () => {
    const name = deriveServiceName('/tmp/amtp-a')
    expect(name).toMatch(/^amtp-amtp-a-[0-9a-f]{6}$/)
  })

  test('is deterministic and distinguishes different paths', () => {
    expect(deriveServiceName('/tmp/amtp-a')).toBe(deriveServiceName('/tmp/amtp-a'))
    expect(deriveServiceName('/tmp/amtp-a')).not.toBe(deriveServiceName('/tmp/amtp-b'))
  })

  test('sanitizes weird basenames to [a-z0-9-]', () => {
    expect(deriveServiceName('/tmp/My Homes/Node_A!')).toMatch(/^amtp-node-a-[0-9a-f]{6}$/)
  })

  test('all-symbol basename falls back to "home"', () => {
    expect(deriveServiceName('/tmp/___')).toMatch(/^amtp-home-[0-9a-f]{6}$/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd node && bun test src/service/name.test.ts`
Expected: FAIL — cannot resolve `./name`.

- [ ] **Step 3: Write the implementation**

Create `node/src/service/name.ts`:

```ts
// Deterministic per-home service naming (spec §"Naming: one service per
// home"): every verb re-derives the same name from the resolved home, so
// `--home` is the only addressing a user ever needs.

import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'

/**
 * "amtp" for the default home (~/.amtp); otherwise
 * `amtp-<sanitized basename>-<first 6 hex of sha256(absolute path)>`.
 */
export function deriveServiceName(home: string): string {
  const abs = resolve(home)
  if (abs === join(homedir(), '.amtp')) return 'amtp'
  const slug =
    basename(abs)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'home'
  const hash6 = createHash('sha256').update(abs).digest('hex').slice(0, 6)
  return `amtp-${slug}-${hash6}`
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd node && bun test src/service/name.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add node/src/service/name.ts node/src/service/name.test.ts
git commit -m "feat(service): deterministic per-home service name derivation"
```

---

### Task 3: Serve command resolution

**Files:**
- Create: `node/src/service/exec-resolve.ts`
- Test: `node/src/service/exec-resolve.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `function resolveServeCommand(input: { execPath: string; scriptPath: string | undefined; binOverride?: string }): string[]` — the absolute argv a unit's ExecStart should run, always ending in `'serve'`.

- [ ] **Step 1: Write the failing test**

Create `node/src/service/exec-resolve.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd node && bun test src/service/exec-resolve.test.ts`
Expected: FAIL — cannot resolve `./exec-resolve`.

- [ ] **Step 3: Write the implementation**

Create `node/src/service/exec-resolve.ts`:

```ts
// Resolve the absolute argv a service unit should run (spec §"Install" #2).
// Unit files need absolute paths: launchd/systemd have no amtp on PATH and
// no working directory to speak of.

import { basename, resolve } from 'node:path'

export interface ExecResolveInput {
  /** process.execPath — the amtp binary itself when compiled, bun under the npm shim. */
  execPath: string
  /** process.argv[1] — the entrypoint script when running under bun. */
  scriptPath: string | undefined
  /** `amtp service install --bin <path>` override. */
  binOverride?: string
}

/** The absolute program + args the unit's ExecStart should run, ending in "serve". */
export function resolveServeCommand(input: ExecResolveInput): string[] {
  if (input.binOverride) return [resolve(input.binOverride), 'serve']
  const execBase = basename(input.execPath)
  if (execBase === 'bun' || execBase === 'bun.exe') {
    if (!input.scriptPath) {
      throw new Error('cannot resolve the amtp entrypoint under bun — pass --bin <path-to-amtp>')
    }
    return [input.execPath, resolve(input.scriptPath), 'serve']
  }
  return [input.execPath, 'serve']
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd node && bun test src/service/exec-resolve.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add node/src/service/exec-resolve.ts node/src/service/exec-resolve.test.ts
git commit -m "feat(service): resolve the serve argv for unit ExecStart (binary/bun-shim/--bin)"
```

---

### Task 4: launchd backend (macOS)

**Files:**
- Create: `node/src/service/launchd.ts`
- Test: `node/src/service/launchd.test.ts`

**Interfaces:**
- Consumes: `ServiceContext`, `ServiceManager`, `Runner`, `InstallResult`, `LogsOptions`, `ServiceStatus` from `./types`; `runOrThrow`, `manualServeHint` from `./run`.
- Produces:
  - `function launchdLabel(name: string): string` → `` `com.amtp.${name}` ``
  - `function serveLogPath(home: string): string` → `` `${home}/logs/serve.log` ``
  - `function renderPlist(ctx: ServiceContext): string`
  - `class LaunchdManager implements ServiceManager`, constructed with `{ ctx: ServiceContext; runner: Runner; uid: number; launchAgentsDir?: string }` (dir defaults to `~/Library/LaunchAgents`; injectable for tests).

- [ ] **Step 1: Write the failing test**

Create `node/src/service/launchd.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd node && bun test src/service/launchd.test.ts`
Expected: FAIL — cannot resolve `./launchd`.

- [ ] **Step 3: Write the implementation**

Create `node/src/service/launchd.ts`:

```ts
// macOS backend: user-level LaunchAgent under ~/Library/LaunchAgents driven
// by `launchctl bootstrap`/`bootout` (spec §"Install" #4). RunAtLoad +
// KeepAlive make bootstrap both "enable" and "start"; bootout is both
// "stop" and "unload", so start and restart are the same bootout+bootstrap
// cycle. stdout/stderr both land in $AMTP_HOME/logs/serve.log.

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { manualServeHint, runOrThrow } from './run'
import type { InstallResult, LogsOptions, Runner, ServiceContext, ServiceManager, ServiceStatus } from './types'

export function launchdLabel(name: string): string {
  return `com.amtp.${name}`
}

/** Combined stdout+stderr log target baked into the plist. */
export function serveLogPath(home: string): string {
  return join(home, 'logs', 'serve.log')
}

function xmlEscape(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/** LaunchAgent plist: run at load, keep alive, AMTP_HOME baked in, no serve flags. */
export function renderPlist(ctx: ServiceContext): string {
  const logPath = serveLogPath(ctx.home)
  const argStrings = ctx.execStart.map((a) => `    <string>${xmlEscape(a)}</string>`).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(launchdLabel(ctx.name))}</string>
  <key>ProgramArguments</key>
  <array>
${argStrings}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>AMTP_HOME</key>
    <string>${xmlEscape(ctx.home)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(logPath)}</string>
</dict>
</plist>
`
}

export interface LaunchdManagerInput {
  ctx: ServiceContext
  runner: Runner
  /** process.getuid() — the gui/<uid> launchd domain. */
  uid: number
  /** Injectable for tests; default ~/Library/LaunchAgents. */
  launchAgentsDir?: string
}

export class LaunchdManager implements ServiceManager {
  readonly name: string
  private readonly ctx: ServiceContext
  private readonly runner: Runner
  private readonly uid: number
  private readonly dir: string

  constructor(input: LaunchdManagerInput) {
    this.ctx = input.ctx
    this.name = input.ctx.name
    this.runner = input.runner
    this.uid = input.uid
    this.dir = input.launchAgentsDir ?? join(homedir(), 'Library', 'LaunchAgents')
  }

  unitPath(): string {
    return join(this.dir, `${launchdLabel(this.name)}.plist`)
  }

  private serviceTarget(): string {
    return `gui/${this.uid}/${launchdLabel(this.name)}`
  }

  private assertInstalled(): void {
    if (!existsSync(this.unitPath())) {
      throw new Error(`service "${this.name}" is not installed — run \`amtp service install\``)
    }
  }

  async install(): Promise<InstallResult> {
    mkdirSync(join(this.ctx.home, 'logs'), { recursive: true })
    mkdirSync(this.dir, { recursive: true })
    writeFileSync(this.unitPath(), renderPlist(this.ctx))
    await this.start0()
    return { warnings: [] }
  }

  /** bootout (ignore "not loaded") + bootstrap: launchd's reload cycle. */
  private async start0(): Promise<void> {
    await this.runner(['launchctl', 'bootout', `gui/${this.uid}`, this.unitPath()])
    await runOrThrow(this.runner, ['launchctl', 'bootstrap', `gui/${this.uid}`, this.unitPath()], manualServeHint(this.ctx))
  }

  async uninstall(): Promise<boolean> {
    if (!existsSync(this.unitPath())) return false
    await this.runner(['launchctl', 'bootout', `gui/${this.uid}`, this.unitPath()])
    rmSync(this.unitPath())
    return true
  }

  async start(): Promise<void> {
    this.assertInstalled()
    await this.start0()
  }

  async stop(): Promise<void> {
    this.assertInstalled()
    await runOrThrow(this.runner, ['launchctl', 'bootout', this.serviceTarget()], manualServeHint(this.ctx))
  }

  async restart(): Promise<void> {
    this.assertInstalled()
    await this.start0()
  }

  async status(): Promise<ServiceStatus> {
    const installed = existsSync(this.unitPath())
    let running = false
    let pid: number | null = null
    if (installed) {
      const res = await this.runner(['launchctl', 'print', this.serviceTarget()])
      if (res.exitCode === 0) {
        const match = res.stdout.match(/^\s*pid = (\d+)/m)
        if (match) {
          running = true
          pid = parseInt(match[1], 10)
        }
      }
    }
    return {
      installed,
      running,
      pid,
      name: this.name,
      unitPath: this.unitPath(),
      home: this.ctx.home,
      execStart: this.ctx.execStart,
    }
  }

  logsCommand(opts: LogsOptions): string[] {
    return ['tail', '-n', String(opts.lines), ...(opts.follow ? ['-f'] : []), serveLogPath(this.ctx.home)]
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd node && bun test src/service/launchd.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 5: Typecheck and commit**

```bash
cd node && bun run typecheck
git add src/service/launchd.ts src/service/launchd.test.ts
git commit -m "feat(service): launchd LaunchAgent backend (plist render + launchctl verbs)"
```

---

### Task 5: systemd backend (Linux)

**Files:**
- Create: `node/src/service/systemd.ts`
- Test: `node/src/service/systemd.test.ts`

**Interfaces:**
- Consumes: `ServiceContext`, `ServiceManager`, `Runner`, `InstallResult`, `LogsOptions`, `ServiceStatus` from `./types`; `runOrThrow`, `manualServeHint` from `./run`.
- Produces:
  - `function systemdUnitName(name: string): string` → `` `${name}.service` ``
  - `function renderUnit(ctx: ServiceContext): string`
  - `class SystemdManager implements ServiceManager`, constructed with `{ ctx: ServiceContext; runner: Runner; unitDir?: string }` (dir defaults to `~/.config/systemd/user`; injectable for tests).

- [ ] **Step 1: Write the failing test**

Create `node/src/service/systemd.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd node && bun test src/service/systemd.test.ts`
Expected: FAIL — cannot resolve `./systemd`.

- [ ] **Step 3: Write the implementation**

Create `node/src/service/systemd.ts`:

```ts
// Linux backend: systemd user unit under ~/.config/systemd/user driven by
// `systemctl --user` (spec §"Install" #4). `loginctl enable-linger` keeps
// the user manager (and thus the service) alive after logout — its failure
// is a warning, not an install failure. Logs go to the user journal.

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { manualServeHint, runOrThrow } from './run'
import type { InstallResult, LogsOptions, Runner, ServiceContext, ServiceManager, ServiceStatus } from './types'

export function systemdUnitName(name: string): string {
  return `${name}.service`
}

/** systemd double-quoting for one token: escape backslash and double-quote. */
function unitQuote(token: string): string {
  return `"${token.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

/** systemd user unit: AMTP_HOME baked in, no serve flags, restart on failure. */
export function renderUnit(ctx: ServiceContext): string {
  return `[Unit]
Description=AMTP node (amtp serve) for ${ctx.home}

[Service]
Environment=${unitQuote(`AMTP_HOME=${ctx.home}`)}
ExecStart=${ctx.execStart.map(unitQuote).join(' ')}
Restart=on-failure

[Install]
WantedBy=default.target
`
}

export interface SystemdManagerInput {
  ctx: ServiceContext
  runner: Runner
  /** Injectable for tests; default ~/.config/systemd/user. */
  unitDir?: string
}

export class SystemdManager implements ServiceManager {
  readonly name: string
  private readonly ctx: ServiceContext
  private readonly runner: Runner
  private readonly dir: string

  constructor(input: SystemdManagerInput) {
    this.ctx = input.ctx
    this.name = input.ctx.name
    this.runner = input.runner
    this.dir = input.unitDir ?? join(homedir(), '.config', 'systemd', 'user')
  }

  unitPath(): string {
    return join(this.dir, systemdUnitName(this.name))
  }

  private assertInstalled(): void {
    if (!existsSync(this.unitPath())) {
      throw new Error(`service "${this.name}" is not installed — run \`amtp service install\``)
    }
  }

  private async systemctl(...args: string[]): Promise<void> {
    await runOrThrow(this.runner, ['systemctl', '--user', ...args], manualServeHint(this.ctx))
  }

  async install(): Promise<InstallResult> {
    mkdirSync(this.dir, { recursive: true })
    writeFileSync(this.unitPath(), renderUnit(this.ctx))
    await this.systemctl('daemon-reload')
    await this.systemctl('enable', '--now', systemdUnitName(this.name))
    const warnings: string[] = []
    const linger = await this.runner(['loginctl', 'enable-linger'])
    if (linger.exitCode !== 0) {
      warnings.push(
        `warning: \`loginctl enable-linger\` failed (exit ${linger.exitCode}) — the service will stop when you log out`
      )
    }
    return { warnings }
  }

  async uninstall(): Promise<boolean> {
    if (!existsSync(this.unitPath())) return false
    await this.runner(['systemctl', '--user', 'disable', '--now', systemdUnitName(this.name)])
    rmSync(this.unitPath())
    await this.runner(['systemctl', '--user', 'daemon-reload'])
    return true
  }

  async start(): Promise<void> {
    this.assertInstalled()
    await this.systemctl('start', systemdUnitName(this.name))
  }

  async stop(): Promise<void> {
    this.assertInstalled()
    await this.systemctl('stop', systemdUnitName(this.name))
  }

  async restart(): Promise<void> {
    this.assertInstalled()
    await this.systemctl('restart', systemdUnitName(this.name))
  }

  async status(): Promise<ServiceStatus> {
    const installed = existsSync(this.unitPath())
    let running = false
    let pid: number | null = null
    if (installed) {
      const res = await this.runner([
        'systemctl',
        '--user',
        'show',
        systemdUnitName(this.name),
        '--property=ActiveState',
        '--property=MainPID',
      ])
      if (res.exitCode === 0) {
        running = /^ActiveState=active$/m.test(res.stdout)
        const match = res.stdout.match(/^MainPID=(\d+)$/m)
        if (match && match[1] !== '0') pid = parseInt(match[1], 10)
      }
    }
    return {
      installed,
      running,
      pid,
      name: this.name,
      unitPath: this.unitPath(),
      home: this.ctx.home,
      execStart: this.ctx.execStart,
    }
  }

  logsCommand(opts: LogsOptions): string[] {
    return [
      'journalctl',
      '--user',
      '-u',
      systemdUnitName(this.name),
      '-n',
      String(opts.lines),
      ...(opts.follow ? ['-f'] : []),
    ]
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd node && bun test src/service/systemd.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 5: Typecheck and commit**

```bash
cd node && bun run typecheck
git add src/service/systemd.ts src/service/systemd.test.ts
git commit -m "feat(service): systemd --user backend (unit render + systemctl verbs + linger)"
```

---

### Task 6: Platform pick — `createServiceManager`

**Files:**
- Create: `node/src/service/manager.ts`
- Test: `node/src/service/manager.test.ts`

**Interfaces:**
- Consumes: `deriveServiceName` (Task 2), `resolveServeCommand` (Task 3), `realRunner`/`manualServeHint` (Task 1), `LaunchdManager` (Task 4), `SystemdManager` (Task 5).
- Produces: `function createServiceManager(input: { home: string; binOverride?: string; platform?: NodeJS.Platform; runner?: Runner }): ServiceManager` — resolves the home to an absolute path, builds the `ServiceContext` from the *current process's* `execPath`/`argv[1]`, and returns the platform backend; throws on unsupported platforms with the manual-supervision hint. `platform`/`runner` are injectable for tests (default `process.platform` / `realRunner`).

- [ ] **Step 1: Write the failing test**

Create `node/src/service/manager.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd node && bun test src/service/manager.test.ts`
Expected: FAIL — cannot resolve `./manager`.

- [ ] **Step 3: Write the implementation**

Create `node/src/service/manager.ts`:

```ts
// Backend selection for `amtp service` (spec §"Architecture"): build the
// ServiceContext from the current process's own executable, then hand it to
// the platform backend. Windows / anything else fails loudly with the exact
// command to supervise manually.

import { resolve } from 'node:path'
import { resolveServeCommand } from './exec-resolve'
import { LaunchdManager } from './launchd'
import { deriveServiceName } from './name'
import { manualServeHint, realRunner } from './run'
import { SystemdManager } from './systemd'
import type { Runner, ServiceContext, ServiceManager } from './types'

export interface CreateServiceManagerInput {
  home: string
  /** `amtp service install --bin <path>`. */
  binOverride?: string
  /** Injectable for tests; default process.platform. */
  platform?: NodeJS.Platform
  /** Injectable for tests; default realRunner. */
  runner?: Runner
}

export function createServiceManager(input: CreateServiceManagerInput): ServiceManager {
  const home = resolve(input.home)
  const ctx: ServiceContext = {
    home,
    name: deriveServiceName(home),
    execStart: resolveServeCommand({
      execPath: process.execPath,
      scriptPath: process.argv[1],
      binOverride: input.binOverride,
    }),
  }
  const platform = input.platform ?? process.platform
  const runner = input.runner ?? realRunner
  if (platform === 'darwin') {
    return new LaunchdManager({ ctx, runner, uid: process.getuid?.() ?? 0 })
  }
  if (platform === 'linux') {
    return new SystemdManager({ ctx, runner })
  }
  throw new Error(`amtp service is not supported on platform "${platform}" — ${manualServeHint(ctx)}`)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd node && bun test src/service/manager.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Typecheck and commit**

```bash
cd node && bun run typecheck
git add src/service/manager.ts src/service/manager.test.ts
git commit -m "feat(service): createServiceManager platform pick + unsupported-platform error"
```

---

### Task 7: CLI wiring — `amtp service <verb>`

**Files:**
- Create: `node/src/commands/service.ts`
- Modify: `node/src/index.ts` (add import + `registerServiceCommands(program)` after `registerServeCommand(program)`)
- Test: `node/src/commands/service.test.ts`

**Interfaces:**
- Consumes: `createServiceManager` (Task 6) and its `CreateServiceManagerInput`; `getCliHome` from `../context`; `configPath` from `../home`; `output`/`outputError` from `../output`; test helpers `newProgram`/`captureLogs`/`parseJsonLog` from `./test-helpers`; `runInit` from `../ops/init`.
- Produces: `function registerServiceCommands(program: Command): void`, plus an exported test seam `setServiceManagerFactory(factory: ((input: CreateServiceManagerInput) => ServiceManager) | undefined): void` (undefined restores the real `createServiceManager`).

- [ ] **Step 1: Write the failing test**

Create `node/src/commands/service.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolve } from 'node:path'
import { setCliHome } from '../context'
import { runInit } from '../ops/init'
import { setOutputOptions } from '../output'
import { LaunchdManager } from '../service/launchd'
import { deriveServiceName } from '../service/name'
import type { Runner, ServiceStatus } from '../service/types'
import { registerServiceCommands, setServiceManagerFactory } from './service'
import { captureLogs, newProgram, parseJsonLog } from './test-helpers'

let workDir: string
let home: string
let agentsDir: string
let calls: string[][]

const okRunner: Runner = async (cmd) => {
  calls.push(cmd)
  return { exitCode: 0, stdout: '', stderr: '' }
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'amtp-service-cmd-test-'))
  home = join(workDir, 'home')
  agentsDir = join(workDir, 'LaunchAgents')
  calls = []
  setCliHome(home)
  setOutputOptions({ json: true })
  // Force the launchd backend with a recording runner and a temp
  // LaunchAgents dir so tests behave identically on any CI platform and
  // never touch the real ~/Library/LaunchAgents.
  setServiceManagerFactory(
    (input) =>
      new LaunchdManager({
        ctx: {
          home: resolve(input.home),
          name: deriveServiceName(resolve(input.home)),
          execStart: ['/bin/amtp', 'serve'],
        },
        runner: okRunner,
        uid: 501,
        launchAgentsDir: agentsDir,
      })
  )
})

afterEach(() => {
  setServiceManagerFactory(undefined)
  setOutputOptions({})
  rmSync(workDir, { recursive: true, force: true })
})

function buildProgram() {
  const program = newProgram()
  registerServiceCommands(program)
  return program
}

describe('amtp service', () => {
  test('is registered with the expected verbs', () => {
    const program = buildProgram()
    const service = program.commands.find((c) => c.name() === 'service')
    expect(service?.commands.map((c) => c.name())).toEqual([
      'install',
      'uninstall',
      'start',
      'stop',
      'restart',
      'status',
      'logs',
    ])
  })

  test('install refuses an uninitialized home', async () => {
    // no runInit(home) here
    let exitCode: number | undefined
    const originalExit = process.exit
    const originalError = console.error
    const errors: string[] = []
    // outputError calls process.exit(1); intercept it like a commander test.
    process.exit = ((code?: number) => {
      exitCode = code
      throw new Error('exit')
    }) as never
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(' '))
    }
    try {
      await expect(buildProgram().parseAsync(['service', 'install'], { from: 'user' })).rejects.toThrow('exit')
    } finally {
      process.exit = originalExit
      console.error = originalError
    }
    expect(exitCode).toBe(1)
    expect(errors.join('\n')).toContain('amtp home not initialized')
    expect(errors.join('\n')).toContain('amtp init')
  })

  test('install on an initialized home reports status + warnings as JSON', async () => {
    runInit(home)
    const logs = await captureLogs(() => buildProgram().parseAsync(['service', 'install'], { from: 'user' }))
    const printed = parseJsonLog<ServiceStatus & { warnings: string[] }>(logs)
    expect(printed.name).toMatch(/^amtp-home-[0-9a-f]{6}$/)
    expect(printed.installed).toBe(true)
    expect(printed.warnings).toEqual([])
    expect(calls.some((c) => c[0] === 'launchctl' && c[1] === 'bootstrap')).toBe(true)
  })

  test('status of a never-installed service reports installed:false', async () => {
    runInit(home)
    const logs = await captureLogs(() => buildProgram().parseAsync(['service', 'status'], { from: 'user' }))
    const printed = parseJsonLog<ServiceStatus>(logs)
    expect(printed.installed).toBe(false)
    expect(printed.running).toBe(false)
  })

  test('uninstall of a never-installed service is a no-op notice', async () => {
    runInit(home)
    const logs = await captureLogs(() => buildProgram().parseAsync(['service', 'uninstall'], { from: 'user' }))
    const printed = parseJsonLog<{ name: string; removed: boolean }>(logs)
    expect(printed.removed).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd node && bun test src/commands/service.test.ts`
Expected: FAIL — cannot resolve `./service`.

- [ ] **Step 3: Write the implementation**

Create `node/src/commands/service.ts`:

```ts
// Commander wiring for `amtp service` (spec §"Command surface"): thin verbs
// over ServiceManager. The module-level factory seam mirrors how other
// command tests inject state (setCliHome/setOutputOptions) — tests swap in a
// manager with a recording Runner and temp dirs.

import { existsSync } from 'node:fs'
import type { Command } from 'commander'
import { getCliHome } from '../context'
import { configPath } from '../home'
import { output, outputError } from '../output'
import type { CreateServiceManagerInput } from '../service/manager'
import { createServiceManager } from '../service/manager'
import type { ServiceManager } from '../service/types'

type ManagerFactory = (input: CreateServiceManagerInput) => ServiceManager

let managerFactory: ManagerFactory = createServiceManager

/** Test seam: swap the manager factory; pass undefined to restore the real one. */
export function setServiceManagerFactory(factory: ManagerFactory | undefined): void {
  managerFactory = factory ?? createServiceManager
}

function managerForHome(binOverride?: string): ServiceManager {
  return managerFactory({ home: getCliHome(), binOverride })
}

export function registerServiceCommands(program: Command): void {
  const service = program
    .command('service')
    .description('Run amtp serve as an always-on user service (launchd on macOS, systemd --user on Linux)')

  service
    .command('install')
    .description('Write the service unit for this home, enable it, and start it (idempotent)')
    .option('--bin <path>', 'amtp executable the service should run (default: the current one)')
    .action(async (options: { bin?: string }) => {
      try {
        const home = getCliHome()
        if (!existsSync(configPath(home))) {
          throw new Error(`amtp home not initialized at ${home} — run "amtp init" first`)
        }
        const manager = managerForHome(options.bin)
        const { warnings } = await manager.install()
        const status = await manager.status()
        output({ ...status, warnings }, [
          `Installed service "${manager.name}" (${manager.unitPath()})`,
          ...warnings,
          `Serve config comes from ${configPath(home)} — edit it and run \`amtp service restart\` to apply.`,
        ])
      } catch (error) {
        outputError(error as Error)
      }
    })

  service
    .command('uninstall')
    .description('Stop the service and remove its unit ($AMTP_HOME itself is untouched)')
    .action(async () => {
      try {
        const manager = managerForHome()
        const removed = await manager.uninstall()
        output(
          { name: manager.name, removed },
          removed
            ? `Uninstalled service "${manager.name}" (${manager.unitPath()} removed; $AMTP_HOME untouched)`
            : `Service "${manager.name}" is not installed — nothing to do`
        )
      } catch (error) {
        outputError(error as Error)
      }
    })

  for (const verb of ['start', 'stop', 'restart'] as const) {
    service
      .command(verb)
      .description(`${verb[0].toUpperCase()}${verb.slice(1)} the installed service`)
      .action(async () => {
        try {
          const manager = managerForHome()
          await manager[verb]()
          output({ name: manager.name, action: verb, ok: true }, `Service "${manager.name}": ${verb} ok`)
        } catch (error) {
          outputError(error as Error)
        }
      })
  }

  service
    .command('status')
    .description("Show installed/running state for this home's service")
    .action(async () => {
      try {
        const status = await managerForHome().status()
        output(status, [
          `Service "${status.name}" (${status.unitPath})`,
          `Home: ${status.home}`,
          `ExecStart: ${status.execStart.join(' ')}`,
          `Installed: ${status.installed ? 'yes' : 'no'}`,
          `Running: ${status.running ? `yes (pid ${status.pid})` : 'no'}`,
        ])
      } catch (error) {
        outputError(error as Error)
      }
    })

  service
    .command('logs')
    .description('Show service logs (launchd: $AMTP_HOME/logs/serve.log; systemd: journalctl --user)')
    .option('-f, --follow', 'Follow log output')
    .option('-n, --lines <n>', 'Number of trailing lines to show', (v) => parseInt(v, 10), 50)
    .action(async (options: { follow?: boolean; lines: number }) => {
      try {
        const manager = managerForHome()
        const cmd = manager.logsCommand({ follow: !!options.follow, lines: options.lines })
        const proc = Bun.spawn(cmd, { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' })
        process.exit(await proc.exited)
      } catch (error) {
        outputError(error as Error)
      }
    })
}
```

Modify `node/src/index.ts` — add the import (alphabetical, next to the other command imports):

```ts
import { registerServiceCommands } from './commands/service'
```

and the registration, directly after `registerServeCommand(program)`:

```ts
registerServiceCommands(program)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd node && bun test src/commands/service.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Run the full suite + typecheck (purity gate must still pass)**

Run: `cd node && bun test && bun run typecheck`
Expected: all green — including `purity.test.ts` picking up the new files.

- [ ] **Step 6: Smoke-test the real CLI on this machine (macOS)**

```bash
cd node && bun src/index.ts service --help
bun src/index.ts --home /tmp/amtp-smoke service status --json   # expect installed:false JSON (after amtp init) or the not-initialized error path via install
```

Expected: help lists all 7 verbs; status returns clean JSON. Do **not** run a real `service install` against the default home during implementation.

- [ ] **Step 7: Commit**

```bash
git add node/src/commands/service.ts node/src/commands/service.test.ts node/src/index.ts
git commit -m "feat(service): amtp service verb group (install/uninstall/start/stop/restart/status/logs)"
```

---

### Task 8: Docs — quickstart + SKILL.md

**Files:**
- Modify: `docs/quickstart.md` (new subsection after step 2, plus a "Next steps" bullet)
- Modify: `node/SKILL.md` (soften the "not a daemon manager" caveat, add the verb group)

**Interfaces:**
- Consumes: the final CLI surface from Task 7 (verb names, flag names, output shapes — keep examples honest).
- Produces: nothing code-facing.

- [ ] **Step 1: Add the quickstart subsection**

In `docs/quickstart.md`, directly after step 2's closing paragraph ("Leave both running. …" ends at line 94), insert:

````markdown
### Optional: keep it running with `amtp service`

Foreground terminals are fine for a walkthrough, but for an instance that
should *always* be receiving, register `serve` with your OS service manager
instead (launchd on macOS, systemd user units on Linux — no sudo needed):

```bash
amtp service install
```
```
Installed service "amtp" (~/Library/LaunchAgents/com.amtp.amtp.plist)
Serve config comes from ~/.amtp/config.json — edit it and run `amtp service restart` to apply.
```

One service per home: the service name derives from `$AMTP_HOME`, so each
instance gets its own (the default home is just `amtp`; `/tmp/amtp-a` would
be `amtp-amtp-a-<hash>`). The unit runs `amtp serve` with no flags — host
and port come from `config.json`, so change them there and
`amtp service restart`. Check on it with:

```bash
amtp service status
amtp service logs -f     # launchd: tails $AMTP_HOME/logs/serve.log; systemd: journalctl
amtp service uninstall   # stops it and removes the unit; $AMTP_HOME is untouched
```

The rest of this walkthrough assumes the foreground `serve` terminals from
step 2 — either way works.
````

(Adjust the literal example output to match what the implemented command actually prints — run it once against a throwaway home and paste the real output, per this doc's convention of showing real transcripts.)

- [ ] **Step 2: Add a "Next steps" bullet**

In `docs/quickstart.md`'s "Next steps" list, add:

```markdown
- Make an instance permanent with `amtp service install` — registers `serve`
  with launchd/systemd (user-level) so it survives reboots.
```

- [ ] **Step 3: Update `node/SKILL.md`**

(a) Replace the sentence in the `serve` section (currently: "it is not a daemon manager, so run it under whatever process supervisor your harness already uses (systemd, tmux, a background job, etc.).") with:

```markdown
it is not itself a daemon manager — run `amtp service install` to register
it as a user-level launchd/systemd service, or use whatever supervisor your
harness already has (tmux, a background job, etc.).
```

(b) Add a new section right before "## Operational extras":

````markdown
## Running serve as a service — `amtp service`

```bash
amtp service install [--bin <path>]   # write + enable + start a user-level unit (idempotent)
amtp service status                   # installed? running? pid, unit path
amtp service logs [-f] [-n <lines>]   # launchd: $AMTP_HOME/logs/serve.log; systemd: journalctl --user
amtp service start|stop|restart
amtp service uninstall                # stop + remove the unit; $AMTP_HOME untouched
```

macOS uses a launchd LaunchAgent (`~/Library/LaunchAgents/com.amtp.<name>.plist`);
Linux uses a systemd user unit (`~/.config/systemd/user/<name>.service`,
with `loginctl enable-linger` so it survives logout). One service per home:
the name derives from `$AMTP_HOME` (`amtp` for the default home,
`amtp-<basename>-<hash>` otherwise), so multiple instances coexist. The unit
never bakes in host/port — edit `config.json` and `amtp service restart`.
Windows and non-systemd Linux are unsupported; the error tells you the exact
command to run under your own supervisor.
````

- [ ] **Step 4: Verify docs**

Run: `cd node && bun src/index.ts service --help` and cross-check every verb/flag mentioned in both docs actually exists with that spelling. Re-read both edited files end to end for flow.

- [ ] **Step 5: Commit**

```bash
git add docs/quickstart.md node/SKILL.md
git commit -m "docs: quickstart + SKILL.md coverage for amtp service"
```

---

## Final verification (after all tasks)

- [ ] `cd node && bun test` — full suite green.
- [ ] `cd node && bun run typecheck` — clean.
- [ ] Manual smoke on this Mac with a throwaway home:

```bash
export AMTP_HOME=/tmp/amtp-svc-smoke
cd node && bun src/index.ts init
bun src/index.ts service install --bin "$(pwd)/dist/amtp"   # build dist first: bun run build
bun src/index.ts service status
curl -s "http://localhost:2687/" >/dev/null; bun src/index.ts service logs -n 20
bun src/index.ts service uninstall
launchctl print "gui/$(id -u)" | grep com.amtp || true      # confirm nothing lingers
rm -rf /tmp/amtp-svc-smoke
```

Expected: install → status shows running with a pid → logs show the serve startup line → uninstall leaves no `com.amtp.*` entries.
