#!/usr/bin/env bun
// amtp — standalone AMTP node CLI entrypoint (spec §7): the commander program
// wiring every one-shot verb + `serve` + `mcp` (spec §8).

import { Command } from 'commander'
import { buildInfo } from './build-info'
import { registerAllowCommands } from './commands/allow'
import { registerAttachCommands } from './commands/attach'
import { registerCardCommands } from './commands/card'
import { registerHandlesCommand } from './commands/handles'
import { registerIdentityCommand, registerWhoamiCommand } from './commands/identity'
import { registerInboxCommands } from './commands/inbox'
import { registerInitCommand } from './commands/init'
import { registerMcpCommand } from './commands/mcp'
import { registerDrainCommand, registerOutboxCommands } from './commands/outbox'
import { registerPeerCommands } from './commands/peer'
import { registerCloseCommand, registerOpenCommand, registerRegisterCommand } from './commands/register'
import { registerSendCommand } from './commands/send'
import { registerServeCommand } from './commands/serve-cli'
import { setCliHome } from './context'
import { resolveAmtpHome } from './home'
import { setOutputOptions } from './output'

const program = new Command()

program
  .name('amtp')
  .description('Standalone AMTP node: identity, peers, mailbox, outbox, HTTP receive host')
  .version(`${buildInfo.version} (${buildInfo.commit}, ${buildInfo.buildDate})`)
  .option('--json', 'Output machine-readable JSON')
  .option('--home <dir>', 'AMTP_HOME override (default: AMTP_HOME env var, else ~/.amtp)')
  .hook('preAction', (thisCommand) => {
    const opts = thisCommand.opts()
    setOutputOptions({ json: !!opts.json })
    setCliHome(resolveAmtpHome(opts.home))
  })

registerInitCommand(program)
registerIdentityCommand(program)
registerWhoamiCommand(program)
registerPeerCommands(program)
registerRegisterCommand(program)
registerOpenCommand(program)
registerCloseCommand(program)
registerHandlesCommand(program)
registerCardCommands(program)
registerSendCommand(program)
registerInboxCommands(program)
registerAttachCommands(program)
registerAllowCommands(program)
registerOutboxCommands(program)
registerDrainCommand(program)
registerServeCommand(program)
registerMcpCommand(program)

program.parse()
