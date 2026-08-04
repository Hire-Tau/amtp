import { Command } from 'commander'
import { getCliHome, openHomeDb } from '../context'
import { listInbox, readMessage } from '../ops/inbox'
import { output, outputError, outputTable } from '../output'

export function registerInboxCommands(program: Command): void {
  const inbox = program.command('inbox').description('Local mailbox: list and read received messages and bounces')

  inbox
    .command('list')
    .description('List inbox messages (newest first)')
    .option('--handle <h>', 'Filter to one local handle')
    .option('--unread', 'Show unread messages only')
    .option('--limit <n>', 'Max messages to show', (v) => parseInt(v, 10))
    .action((options) => {
      try {
        const db = openHomeDb(getCliHome())
        try {
          const messages = listInbox(db, {
            handle: options.handle,
            unreadOnly: !!options.unread,
            limit: options.limit,
          })
          outputTable(
            messages.map((m) => ({
              ...m,
              read: m.read ? 'yes' : 'no',
              receivedAt: new Date(m.receivedAt).toISOString(),
            })),
            ['id', 'kind', 'from', 'subject', 'receivedAt', 'read', 'attachmentCount']
          )
        } finally {
          db.close()
        }
      } catch (error) {
        outputError(error as Error)
      }
    })

  inbox
    .command('read <messageId>')
    .description('Show a full message (marks it read unless --keep-unread)')
    .option('--keep-unread', 'Do not mark the message as read')
    .action((messageId, options) => {
      try {
        const db = openHomeDb(getCliHome())
        try {
          const message = readMessage(db, messageId, { keepUnread: options.keepUnread })
          output(message, [
            `[${message.kind}] ${message.id}`,
            `From: ${message.from}`,
            message.subject ? `Subject: ${message.subject}` : undefined,
            `Envelope id: ${message.envelopeId ?? '(none)'}`,
            `Agent-sig verified: ${message.agentSigVerified}`,
            '',
            message.content,
            ...(message.attachments.length
              ? [
                  '',
                  'Attachments:',
                  ...message.attachments.map((a) => `  ${a.id}  ${a.filename} (${a.byteSize}B, sha256 ${a.sha256})`),
                ]
              : []),
            ...(message.bounce ? ['', `Bounce reason: ${message.bounce.reason}`] : []),
          ])
        } finally {
          db.close()
        }
      } catch (error) {
        outputError(error as Error)
      }
    })
}
