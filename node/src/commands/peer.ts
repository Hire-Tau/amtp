import { existsSync, readFileSync } from 'node:fs'
import { Command } from 'commander'
import { getCliHome, openHomeDb } from '../context'
import { addPeer, listPeers, removePeer } from '../ops/peers'
import { output, outputError, outputTable } from '../output'

/** A `--public-key` value may be a file path or a literal PEM string (same affordance as apps/cli's `resolvePublicKey`). */
export function resolvePublicKey(value: string): string {
  if (existsSync(value)) return readFileSync(value, 'utf8')
  return value
}

export function registerPeerCommands(program: Command): void {
  const peer = program.command('peer').description('Manage federation peers')

  peer
    .command('add')
    .description('Add a peer (derives + verifies the instance id from --public-key)')
    .requiredOption('--alias <alias>', 'Local alias for the peer')
    .requiredOption('--base-url <url>', "Peer's base URL")
    .requiredOption('--public-key <pemOrFile>', "Peer's public key (PEM string or file path)")
    .option('--instance-id <id>', 'Expected instance id — must match the id derived from --public-key')
    .action((options) => {
      try {
        const db = openHomeDb(getCliHome())
        try {
          const created = addPeer(db, {
            alias: options.alias,
            baseUrl: options.baseUrl,
            publicKeyPem: resolvePublicKey(options.publicKey),
            instanceId: options.instanceId,
          })
          output(created, `Added peer "${created.alias}" (${created.instanceId})`)
        } finally {
          db.close()
        }
      } catch (error) {
        outputError(error as Error)
      }
    })

  peer
    .command('list')
    .description('List configured peers')
    .action(() => {
      try {
        const db = openHomeDb(getCliHome())
        try {
          outputTable(listPeers(db), ['alias', 'instanceId', 'baseUrl', 'status'])
        } finally {
          db.close()
        }
      } catch (error) {
        outputError(error as Error)
      }
    })

  peer
    .command('remove <ref>')
    .description('Remove a peer by alias or instance id')
    .action((ref) => {
      try {
        const db = openHomeDb(getCliHome())
        try {
          if (!removePeer(db, ref)) throw new Error(`unknown peer: ${ref}`)
          output({ removed: true }, `Removed peer ${ref}`)
        } finally {
          db.close()
        }
      } catch (error) {
        outputError(error as Error)
      }
    })
}
