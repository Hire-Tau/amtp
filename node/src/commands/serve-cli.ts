// Thin commander wiring around `startServe` (./serve.ts, Task 3). Kept as a
// separate module so this task's CLI wiring doesn't touch the already-tested
// `serve.ts` file.

import { Command } from 'commander'
import { getCliHome } from '../context'
import { outputError } from '../output'
import { startServe } from './serve'

export function registerServeCommand(program: Command): void {
  program
    .command('serve')
    .description('Run the HTTP receive host + outbox drain loop + maintenance (long-running; not a daemon manager)')
    .option('--host <host>', 'Bind host (default: config.json serve.host, else 0.0.0.0)')
    .option('--port <port>', 'Bind port (default: config.json serve.port, else 2687; 0 = ephemeral)', (v) =>
      parseInt(v, 10)
    )
    .action(async (options) => {
      try {
        await startServe({ home: getCliHome(), hostOverride: options.host, portOverride: options.port })
      } catch (error) {
        outputError(error as Error)
      }
    })
}
