import { Command } from 'commander'
import { getCliHome, openHomeDb } from '../context'
import { buildNodeEngine } from '../engine'
import { fetchPeerHandles } from '../ops/handles'
import { outputError, outputTable } from '../output'

export function registerHandlesCommand(program: Command): void {
  program
    .command('handles <peer>')
    .description("List a peer's published federation handles (peer = alias or instance id)")
    .action(async (peerRef) => {
      try {
        const home = getCliHome()
        const db = openHomeDb(home)
        try {
          const engine = buildNodeEngine(db, home)
          const handles = await fetchPeerHandles(engine, db, peerRef)
          outputTable(handles, ['handle', 'address'])
        } finally {
          db.close()
        }
      } catch (error) {
        outputError(error as Error)
      }
    })
}
