import { Command } from 'commander'
import { getCliHome, openHomeDb } from '../context'
import { setCard } from '../ops/cards'
import { getIdentity } from '../ops/identity'
import { register, setInboundOpen } from '../ops/registrations'
import { output, outputError } from '../output'

export function registerRegisterCommand(program: Command): void {
  program
    .command('register <handle>')
    .description(
      'Claim a local handle (amtp://<instanceId>/<handle>); re-running is an idempotent no-op unless --regenerate'
    )
    .option('--open', 'Open the mailbox for inbound mail')
    .option('--regenerate', "Regenerate this handle's agent keypair (breaks every peer's TOFU pin for it)")
    .option('--name <name>', 'Also publish a card with this display name')
    .option('--description <text>', 'Also publish a card with this description')
    .action((handle, options) => {
      try {
        const db = openHomeDb(getCliHome())
        try {
          const identity = getIdentity(db)
          const result = register(db, identity.instanceId, {
            handle,
            open: options.open,
            regenerate: options.regenerate,
          })

          const lines = [
            result.regenerated
              ? `Regenerated the agent keypair for "${result.handle}".`
              : result.alreadyRegistered
                ? `Handle "${result.handle}" is already registered (no-op).`
                : `Registered "${result.handle}".`,
            `Address: ${result.address}`,
            `Agent public key:\n${result.agentPublicKeyPem}`,
          ]
          if (result.regenerated) {
            lines.push(
              "WARNING: every peer's TOFU pin for this handle is now STALE. Their receivers will 403 " +
                '(pin_mismatch) on mail from this handle until they clear the stale pin out-of-band.'
            )
          }

          if (options.name || options.description) {
            const signedCard = setCard(db, identity.instanceId, {
              handle,
              name: options.name,
              description: options.description,
            })
            lines.push(`Published card. Name: ${signedCard.card.name ?? '(none)'}`)
            output({ ...result, card: signedCard }, lines)
          } else {
            output(result, lines)
          }
        } finally {
          db.close()
        }
      } catch (error) {
        outputError(error as Error)
      }
    })
}

function registerToggleCommand(program: Command, name: 'open' | 'close', open: boolean): void {
  program
    .command(`${name} <handle>`)
    .description(`${open ? 'Open' : 'Close'} a handle's mailbox`)
    .action((handle) => {
      try {
        const db = openHomeDb(getCliHome())
        try {
          setInboundOpen(db, handle, open)
          output({ handle, inboundOpen: open }, `Mailbox ${open ? 'opened' : 'closed'} for "${handle}".`)
        } finally {
          db.close()
        }
      } catch (error) {
        outputError(error as Error)
      }
    })
}

export function registerOpenCommand(program: Command): void {
  registerToggleCommand(program, 'open', true)
}

export function registerCloseCommand(program: Command): void {
  registerToggleCommand(program, 'close', false)
}
