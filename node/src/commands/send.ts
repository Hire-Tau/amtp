import { Command } from 'commander'
import { getCliHome, openHomeDb } from '../context'
import { buildNodeEngine } from '../engine'
import { send } from '../ops/send'
import { output, outputError } from '../output'

function collect(value: string, previous: string[]): string[] {
  return [...previous, value]
}

/** `<content | ->`: `-` reads the message body from stdin (spec §7.2). */
async function resolveContent(content: string): Promise<string> {
  if (content !== '-') return content
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export function registerSendCommand(program: Command): void {
  program
    .command('send <to> <content>')
    .description(
      'Send a message to a remote amtp:// address (enqueue + immediate drain unless --queue-only); content "-" reads from stdin'
    )
    .option('--from <handle>', 'Authoring handle (defaults when exactly one handle is registered)')
    .option('-s, --subject <subject>', 'Message subject')
    .option('--attach-id <id>', 'Reference an attachment staged with "amtp attach upload" (repeatable)', collect, [])
    .option('--in-reply-to <envelopeId>', 'Remote envelope id this message replies to (from "inbox read")')
    .option(
      '--envelope-id <uuid>',
      'Explicit envelope id — also the idempotency key (a re-run with the same id returns the existing entry)'
    )
    .option('--no-sign', 'Send unsigned (default: signed with the handle agent key)')
    .option('--queue-only', 'Enqueue only; skip the immediate drain')
    .action(async (to, content, options) => {
      try {
        const home = getCliHome()
        const db = openHomeDb(home)
        try {
          const engine = buildNodeEngine(db, home)
          const resolvedContent = await resolveContent(content)
          const result = await send(db, engine, {
            toAddress: to,
            content: resolvedContent,
            fromHandle: options.from,
            subject: options.subject,
            attachIds: options.attachId,
            inReplyTo: options.inReplyTo,
            envelopeId: options.envelopeId,
            sign: options.sign,
            queueOnly: options.queueOnly,
          })
          output(
            result,
            `Outbox ${result.outboxId.slice(0, 8)} (envelope ${result.envelopeId.slice(0, 8)}): ${result.status}` +
              (result.nextAttemptAt ? ` (next attempt ${new Date(result.nextAttemptAt).toISOString()})` : '') +
              (result.lastError ? ` — ${result.lastError}` : '')
          )
        } finally {
          db.close()
        }
      } catch (error) {
        outputError(error as Error)
      }
    })
}
