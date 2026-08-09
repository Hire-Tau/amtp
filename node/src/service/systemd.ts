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
