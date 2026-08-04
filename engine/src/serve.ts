import type { AmtpEnginePorts } from './options'
import type { ServeAttachmentResult } from './results'

// ---------------------------------------------------------------------------
// §5.5 serveAttachment (§10.2, default-deny)
// ---------------------------------------------------------------------------

/**
 * Ported from routes/amtp.ts:583-610. Default-deny: `{found:false}` when the
 * peer never had this attachment advertised to it (outbox check), OR the
 * attachment id / blob is unknown — one uniform not-found for unauthorized
 * peer / unknown id / missing blob (the host maps `{found:false}` to a 404
 * with an identical body, never distinguishing the cause).
 */
export async function serveAttachment(
  ports: AmtpEnginePorts,
  args: { peerInstanceId: string; attachmentId: string }
): Promise<ServeAttachmentResult> {
  const authorized = await ports.outbox.hasOutboundAttachmentForPeer(args.peerInstanceId, args.attachmentId)
  if (!authorized) return { found: false }

  const blob = await ports.attachments.readOutboundBlob(args.attachmentId)
  if (!blob) return { found: false }

  return { found: true, bytes: blob.bytes, contentType: blob.contentType, byteSize: blob.byteSize }
}
