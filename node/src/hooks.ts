// §4.9 `delivery` (DeliveryHooks).
//
// Spec: docs/superpowers/specs/2026-07-08-amtp-node-design.md §4.9.
//
// `onMessageReceived`'s rollback contract (§4.10 engine-side normative text —
// "throwing leaves NO host-visible partial state") is met by: writing every
// attachment blob to disk FIRST (fresh local UUID per blob, never the
// sender-chosen wire ref id — C1, spec §4.9 bullet 1), THEN one
// `BEGIN IMMEDIATE` sqlite transaction inserting the message row + all
// attachment rows. On any throw (mid blob-write OR mid transaction): the
// transaction rolls back automatically (bun:sqlite re-throws the original
// error after ROLLBACK), and every blob renamed so far is unlinked
// best-effort before rethrowing.
//
// `writeBlob` is an injectable seam (default: the real durable writer) so
// the contract-kit's `failAfterAttachments` case can force a mid-persist
// failure without a real disk-quota mechanism (§10.4) — this is the node's
// analogue of the reference host forcing the failure through its real quota enforcement.

import { unlinkSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, join } from 'node:path'
import type { Database } from 'bun:sqlite'
import type { DeliveryHooks } from 'amtp-engine'
import { blobsDir } from './home'
import { writeBlobDurable } from './blobs'

export interface DeliveryHooksOptions {
  /** Default: writeBlobDurable. Injectable for the contract kit's
   *  failAfterAttachments seam. */
  writeBlob?: (home: string, finalId: string, data: Uint8Array) => void
  /** Default: no-op. Mirrors the engine's own logger shape. */
  logger?: (level: 'info' | 'warn', message: string) => void
}

export function buildDeliveryHooks(db: Database, home: string, opts: DeliveryHooksOptions = {}): DeliveryHooks {
  const writeBlob = opts.writeBlob ?? writeBlobDurable
  const logger = opts.logger ?? (() => {})

  return {
    // `senderHandle` is intentionally unused: the node's `messages` schema
    // has no separate from-handle column — `from_address` (envelope.from,
    // the full amtp:// address) already carries it, and it's trivially
    // re-derivable via `parseAmtpAddress` at read time if ever needed.
    async onMessageReceived({ envelope, peerInstanceId, recipientRef, agentSigVerified, attachments }) {
      const writtenBlobIds: string[] = []
      const attachmentRows: Array<{
        id: string
        filename: string
        contentType: string
        byteSize: number
        sha256: string
      }> = []

      try {
        for (const { ref, bytes } of attachments) {
          const id = randomUUID()
          writeBlob(home, id, bytes)
          writtenBlobIds.push(id)
          // `ref.filename` is sender-controlled (wire ref, unconstrained by the
          // protocol schema) — strip any directory components before it ever
          // reaches the db, so a hostile separator (e.g. `../../../etc/x`)
          // can't later be joined into a filesystem path unsanitized
          // (path traversal, see ops/attach.ts's downloadAttachment).
          const safeFilename = (() => {
            const name = basename(ref.filename)
            return name === '' || name === '.' ? id : name
          })()
          attachmentRows.push({
            id,
            filename: safeFilename,
            contentType: ref.contentType,
            byteSize: ref.byteSize,
            sha256: ref.sha256,
          })
        }

        const insertTxn = db.transaction(() => {
          const messageId = randomUUID()
          const now = Date.now()
          db.run(
            `INSERT INTO messages (id, kind, handle, peer_instance_id, from_address, envelope_id, subject, content, in_reply_to, agent_key, agent_sig_verified, received_at)
             VALUES (?, 'received', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              messageId,
              recipientRef,
              peerInstanceId,
              envelope.from,
              envelope.id,
              envelope.subject ?? null,
              envelope.content,
              envelope.inReplyTo ?? null,
              envelope.agentKey ?? null,
              agentSigVerified ? 1 : 0,
              now,
            ]
          )
          for (const att of attachmentRows) {
            db.run(
              `INSERT INTO attachments (id, message_id, direction, filename, content_type, byte_size, sha256, storage_path, created_at)
               VALUES (?, ?, 'in', ?, ?, ?, ?, ?, ?)`,
              [att.id, messageId, att.filename, att.contentType, att.byteSize, att.sha256, att.id, now]
            )
          }
        }).immediate
        insertTxn()
      } catch (err) {
        for (const id of writtenBlobIds) {
          try {
            unlinkSync(join(blobsDir(home), id))
          } catch {
            // best-effort
          }
        }
        throw err
      }
    },

    async onDeliveryFailed({ outboxId, envelopeId, toAddress, senderHandle, subject, reason, attempts }) {
      if (!senderHandle) {
        logger('warn', `Outbox row ${outboxId} dead-lettered; sender address did not parse — no bounce`)
        return
      }

      const registration = db
        .query<{ handle: string }, [string]>('SELECT handle FROM registrations WHERE handle = ?')
        .get(senderHandle)
      if (!registration) {
        logger('warn', `Outbox row ${outboxId} dead-lettered; sender handle ${senderHandle} not registered — no bounce`)
        return
      }

      const originalSubject = subject ? `\nOriginal subject: ${subject}` : ''
      const content =
        `Your federated message to ${toAddress} could not be delivered and will not be retried.\n` +
        `Reason: ${reason}\nAttempts: ${attempts}${originalSubject}\nEnvelope id: ${envelopeId}`

      db.run(
        `INSERT INTO messages (id, kind, handle, from_address, envelope_id, subject, content, bounce_json, received_at)
         VALUES (?, 'bounce', ?, 'system', ?, ?, ?, ?, ?)`,
        [
          randomUUID(),
          senderHandle,
          envelopeId,
          `Delivery failed: ${toAddress}`,
          content,
          JSON.stringify({ outboxId, envelopeId, toAddress, reason }),
          Date.now(),
        ]
      )
    },
  }
}
