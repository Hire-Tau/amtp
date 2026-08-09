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
    await this.bootCycle()
    return { warnings: [] }
  }

  /** bootout (ignore "not loaded") + bootstrap: launchd's reload cycle. */
  private async bootCycle(): Promise<void> {
    await this.runner(['launchctl', 'bootout', `gui/${this.uid}`, this.unitPath()])
    await runOrThrow(
      this.runner,
      ['launchctl', 'bootstrap', `gui/${this.uid}`, this.unitPath()],
      manualServeHint(this.ctx)
    )
  }

  async uninstall(): Promise<boolean> {
    if (!existsSync(this.unitPath())) return false
    await this.runner(['launchctl', 'bootout', `gui/${this.uid}`, this.unitPath()])
    rmSync(this.unitPath())
    return true
  }

  async start(): Promise<void> {
    this.assertInstalled()
    await this.bootCycle()
  }

  async stop(): Promise<void> {
    this.assertInstalled()
    await runOrThrow(this.runner, ['launchctl', 'bootout', this.serviceTarget()], manualServeHint(this.ctx))
  }

  async restart(): Promise<void> {
    this.assertInstalled()
    await this.bootCycle()
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
