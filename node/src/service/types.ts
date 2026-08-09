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
