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
