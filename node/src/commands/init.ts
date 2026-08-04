import { Command } from 'commander'
import { getCliHome } from '../context'
import { runInit } from '../ops/init'
import { output, outputError } from '../output'

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Initialize this AMTP home: create the sqlite db, generate the instance identity, write config.json')
    .action(() => {
      try {
        const home = getCliHome()
        const result = runInit(home)
        output(
          result,
          result.alreadyInitialized
            ? `Already initialized. Instance id: ${result.instanceId}`
            : `Initialized ${home}. Instance id: ${result.instanceId}`
        )
      } catch (error) {
        outputError(error as Error)
      }
    })
}
