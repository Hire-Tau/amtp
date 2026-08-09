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
