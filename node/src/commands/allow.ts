import { Command } from 'commander'
import { getCliHome, openHomeDb } from '../context'
import { addAllowRule, listAllowRules, removeAllowRule } from '../ops/allow'
import { output, outputError, outputTable } from '../output'

export function registerAllowCommands(program: Command): void {
  const allow = program.command('allow').description('Manage receive-policy allow rules for closed mailboxes')

  allow
    .command('add <handle>')
    .description('Allow a peer (optionally scoped to one remote sender handle) to reach a closed mailbox')
    .requiredOption('--peer <ref>', 'Peer alias or instance id')
    .option('--sender <remoteHandle>', 'Restrict to this remote sender handle (default: any sender on that peer)')
    .action((handle, options) => {
      try {
        const db = openHomeDb(getCliHome())
        try {
          const result = addAllowRule(db, { handle, peerRef: options.peer, senderHandle: options.sender })
          output(result, `Added allow rule ${result.ruleId}`)
        } finally {
          db.close()
        }
      } catch (error) {
        outputError(error as Error)
      }
    })

  allow
    .command('list [handle]')
    .description('List allow rules (optionally scoped to one local handle)')
    .action((handle) => {
      try {
        const db = openHomeDb(getCliHome())
        try {
          outputTable(listAllowRules(db, handle), ['ruleId', 'handle', 'peerInstanceId', 'kind', 'value'])
        } finally {
          db.close()
        }
      } catch (error) {
        outputError(error as Error)
      }
    })

  allow
    .command('remove <ruleId>')
    .description('Remove an allow rule')
    .action((ruleId) => {
      try {
        const db = openHomeDb(getCliHome())
        try {
          if (!removeAllowRule(db, ruleId)) throw new Error(`unknown allow rule: ${ruleId}`)
          output({ removed: true })
        } finally {
          db.close()
        }
      } catch (error) {
        outputError(error as Error)
      }
    })
}
