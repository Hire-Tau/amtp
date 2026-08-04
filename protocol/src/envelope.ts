import { z } from 'zod'

export interface AmtpAttachmentRef {
  id: string
  filename: string
  contentType: string
  byteSize: number
  sha256: string
}

export interface AmtpEnvelope {
  v: 1
  id: string // uuid nonce — replay/dedup key
  ts: number // epoch ms — freshness (±5 min)
  from: string // amtp://<senderInstanceId>/<senderHandle>
  to: string // amtp://<recipientInstanceId>/<recipientHandle>
  subject?: string
  content: string
  inReplyTo?: string // envelope id being replied to (optional)
  agentKey?: string // opaque, UNVERIFIED in Slice 3
  agentSig?: string // opaque, UNVERIFIED in Slice 3
  attachments?: AmtpAttachmentRef[]
}

export const amtpAttachmentRefSchema = z.object({
  id: z.string().min(1),
  filename: z.string().min(1),
  contentType: z.string().min(1),
  byteSize: z.number().int().min(0),
  sha256: z.string().min(1),
})

export const amtpEnvelopeSchema = z.object({
  v: z.literal(1),
  id: z.string().min(1),
  ts: z.number(),
  from: z.string().min(1),
  to: z.string().min(1),
  subject: z.string().min(1).optional(),
  content: z.string().min(1),
  inReplyTo: z.string().min(1).optional(),
  agentKey: z.string().min(1).optional(),
  agentSig: z.string().min(1).optional(),
  attachments: z.array(amtpAttachmentRefSchema).optional(),
})
