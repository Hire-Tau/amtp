// Shared commander test scaffolding for src/commands/*.test.ts. Mirrors
// apps/cli's commander-test pattern (apps/cli/src/commands/amtp.test.ts):
// build a bare `Command`, register just the command group under test, then
// `parseAsync` synthetic argv. `setCliHome` stands in for what the real root
// program's `preAction` hook would set from a parsed `--home` flag — these
// tests register only one command group at a time, not the full program.

import { Command } from 'commander'

export function newProgram(): Command {
  const program = new Command()
  program.exitOverride()
  return program
}

/**
 * Run `fn`, capturing every `console.log` call as one array entry (joined
 * args), then restore. Deliberately a plain stand-in function (not
 * `bun:test`'s `mock()`) — this module isn't itself a `.test.ts` file, and
 * the purity gate scopes `bun:test` imports to test files only.
 */
export async function captureLogs(fn: () => Promise<unknown> | unknown): Promise<string[]> {
  const logs: string[] = []
  const originalLog = console.log
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '))
  }
  try {
    await fn()
  } finally {
    console.log = originalLog
  }
  return logs
}

/** Parse the single JSON blob printed by `output()`/`outputTable()` under `--json` (one console.log call). */
export function parseJsonLog<T>(logs: string[]): T {
  return JSON.parse(logs.join('')) as T
}
