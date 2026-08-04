import { Command } from 'commander'
import { getCliHome, openHomeDb } from '../context'
import { getIdentity, getWhoami } from '../ops/identity'
import { output, outputError } from '../output'

export function registerIdentityCommand(program: Command): void {
  program
    .command('identity')
    .description(
      "Show this instance's federation identity (instance id + public key) — what a peer operator needs to `peer add` this node"
    )
    .action(() => {
      try {
        const db = openHomeDb(getCliHome())
        try {
          output(getIdentity(db))
        } finally {
          db.close()
        }
      } catch (error) {
        outputError(error as Error)
      }
    })
}

export function registerWhoamiCommand(program: Command): void {
  program
    .command('whoami')
    .description('Show this instance id and every local handle registration')
    .action(() => {
      try {
        const db = openHomeDb(getCliHome())
        try {
          output(getWhoami(db))
        } finally {
          db.close()
        }
      } catch (error) {
        outputError(error as Error)
      }
    })
}
