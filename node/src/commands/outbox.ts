// `amtp outbox list` + `amtp drain` (spec §7.2). Both verbs are in the spec's
// verb table under a plan section that otherwise didn't name them
// explicitly — included per the plan's global constraint "spec-vs-plan
// conflict → spec wins" (dead-letter visibility + cron-mode operation
// without the daemon are called out as deliberate judgment additions, §7.2).

import { Command } from 'commander'
import { getCliHome, openHomeDb } from '../context'
import { buildNodeEngine } from '../engine'
import { listOutbox } from '../ops/outbox'
import { output, outputError, outputTable } from '../output'

export function registerOutboxCommands(program: Command): void {
  const outbox = program.command('outbox').description('Outbox visibility (dead-letter queue)')

  outbox
    .command('list')
    .description('List outbox entries')
    .option('--status <status>', 'Filter by status: pending|delivering|delivered|failed')
    .action((options) => {
      try {
        const db = openHomeDb(getCliHome())
        try {
          outputTable(listOutbox(db, options.status), [
            'id',
            'toAddress',
            'status',
            'attempts',
            'nextAttemptAt',
            'lastError',
          ])
        } finally {
          db.close()
        }
      } catch (error) {
        outputError(error as Error)
      }
    })
}

export function registerDrainCommand(program: Command): void {
  program
    .command('drain')
    .description('Run one outbox drain pass (delivers due entries); enables cron-mode operation without "amtp serve"')
    .action(async () => {
      try {
        const home = getCliHome()
        const db = openHomeDb(home)
        try {
          const engine = buildNodeEngine(db, home)
          const result = await engine.drainOutboxOnce()
          output(result, `delivered=${result.delivered} retried=${result.retried} failed=${result.failedTerminal}`)
        } finally {
          db.close()
        }
      } catch (error) {
        outputError(error as Error)
      }
    })
}
