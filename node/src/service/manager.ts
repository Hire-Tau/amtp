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
