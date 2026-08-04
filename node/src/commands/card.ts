// `amtp card set|show|clear|fetch` (spec §4.6, §7.2): publish/inspect/clear a
// handle's own signed agent card, and fetch+verify a peer handle's card.

import { Command } from 'commander'
import { getCliHome, openHomeDb } from '../context'
import { buildNodeEngine } from '../engine'
import { getIdentity } from '../ops/identity'
import { clearCard, getCard, setCard } from '../ops/cards'
import { output, outputError } from '../output'

function parseExtPairs(pairs: string[] | undefined): Record<string, unknown> | undefined {
  if (!pairs?.length) return undefined
  const out: Record<string, unknown> = {}
  for (const p of pairs) {
    const i = p.indexOf('=')
    if (i < 1) throw new Error(`--ext expects key=value, got "${p}"`)
    const key = p.slice(0, i)
    const raw = p.slice(i + 1)
    try {
      out[key] = JSON.parse(raw)
    } catch {
      out[key] = raw
    }
  }
  return out
}

/**
 * `ops/cards.ts`'s `getCard` throws a raw `SyntaxError` straight out of
 * `JSON.parse` on a corrupt `card_json` row (unlike the handle-directory
 * adapter, which degrades a bad row to `null` for read-path callers). This
 * command/tool layer must not let that raw parse error escape as-is —
 * rewrap it into a clear, actionable message before it reaches `outputError`
 * / the MCP tool error channel.
 */
function safeGetCard(db: Parameters<typeof getCard>[0], handle: string): ReturnType<typeof getCard> {
  try {
    return getCard(db, handle)
  } catch (error) {
    throw new Error(
      `stored card for handle "${handle}" is corrupted and could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }
}

export function registerCardCommands(program: Command): void {
  const card = program.command('card').description("Publish/inspect a handle's signed agent card (spec §4.6)")

  card
    .command('set <handle>')
    .description("Sign and publish the handle's card (replaces any existing card)")
    .option('--name <name>', 'Display name (≤ 200 chars)')
    .option('--description <text>', 'Bio / who this agent is (≤ 2000 chars)')
    .option('--ext <kv...>', 'Extension entries key=value (value parsed as JSON when possible)')
    .action((handle, options) => {
      try {
        const db = openHomeDb(getCliHome())
        try {
          const identity = getIdentity(db)
          const signed = setCard(db, identity.instanceId, {
            handle,
            name: options.name,
            description: options.description,
            extensions: parseExtPairs(options.ext),
          })
          output(signed, [`Published card for "${handle}".`, `Name: ${signed.card.name ?? '(none)'}`])
        } finally {
          db.close()
        }
      } catch (error) {
        outputError(error as Error)
      }
    })

  card
    .command('show <handle>')
    .description("Print the handle's locally stored signed card")
    .action((handle) => {
      try {
        const db = openHomeDb(getCliHome())
        try {
          const signed = safeGetCard(db, handle)
          output(
            signed ?? { card: null },
            signed
              ? [
                  `Card for "${handle}":`,
                  `Name: ${signed.card.name ?? '(none)'}`,
                  `Description: ${signed.card.description ?? '(none)'}`,
                ]
              : `No card published for "${handle}".`
          )
        } finally {
          db.close()
        }
      } catch (error) {
        outputError(error as Error)
      }
    })

  card
    .command('clear <handle>')
    .description("Remove the handle's published card")
    .action((handle) => {
      try {
        const db = openHomeDb(getCliHome())
        try {
          clearCard(db, handle)
          output({ handle, cleared: true }, `Cleared the published card for "${handle}".`)
        } finally {
          db.close()
        }
      } catch (error) {
        outputError(error as Error)
      }
    })

  card
    .command('fetch <handle>')
    .description("Fetch and VERIFY a peer handle's card (TOFU-pinned signature)")
    .requiredOption('--peer <instanceId>', 'Peer instance id')
    .action(async (handle, options) => {
      try {
        const home = getCliHome()
        const db = openHomeDb(home)
        try {
          const engine = buildNodeEngine(db, home)
          const result = await engine.fetchPeerAgentCard({ peerInstanceId: options.peer, handle })
          if (!result.ok) {
            throw new Error(`failed to fetch/verify card for "${handle}" from peer "${options.peer}"`)
          }
          output(result, [
            `Card for "${handle}" @ ${options.peer}:`,
            `Name: ${result.card.name ?? '(none)'}`,
            `Description: ${result.card.description ?? '(none)'}`,
          ])
        } finally {
          db.close()
        }
      } catch (error) {
        outputError(error as Error)
      }
    })
}
