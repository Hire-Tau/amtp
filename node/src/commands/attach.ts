import { Command } from 'commander'
import { getCliHome, openHomeDb } from '../context'
import { downloadAttachment, uploadAttachment } from '../ops/attach'
import { output, outputError } from '../output'

export function registerAttachCommands(program: Command): void {
  const attach = program.command('attach').description('Stage outbound attachments and download received ones')

  attach
    .command('upload <file>')
    .description('Stage a local file as an outbound attachment (use its id with "send --attach-id")')
    .option('--content-type <ct>', 'MIME type (default: application/octet-stream)')
    .option('--filename <name>', 'Override the stored filename (default: the basename of <file>)')
    .action((file, options) => {
      try {
        const home = getCliHome()
        const db = openHomeDb(home)
        try {
          const result = uploadAttachment(db, home, file, {
            contentType: options.contentType,
            filename: options.filename,
          })
          output(
            result,
            `Staged attachment ${result.attachmentId} (${result.filename}, ${result.byteSize}B, sha256 ${result.sha256})`
          )
        } finally {
          db.close()
        }
      } catch (error) {
        outputError(error as Error)
      }
    })

  attach
    .command('download <attachmentId>')
    .description('Copy a locally stored attachment to a file')
    .option('-o, --out <path>', 'Destination file or directory (default: cwd, named after the stored filename)')
    .action((attachmentId, options) => {
      try {
        const home = getCliHome()
        const db = openHomeDb(home)
        try {
          const result = downloadAttachment(db, home, attachmentId, options.out)
          output(result, `Saved ${result.path} (sha256 ${result.sha256})`)
        } finally {
          db.close()
        }
      } catch (error) {
        outputError(error as Error)
      }
    })
}
