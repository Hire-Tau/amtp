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
