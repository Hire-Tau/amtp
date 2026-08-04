// Security regression: an inbound attachment's `filename` is sender-controlled
// (wire ref, unconstrained by the protocol schema beyond non-empty — see
// packages/amtp-protocol/src/envelope.ts's amtpAttachmentRefSchema) and must
// never be allowed to carry path separators into the db, since it's later
// joined into a filesystem path unsanitized by ops/attach.ts's
// downloadAttachment.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'bun:sqlite'
import type { AmtpEnvelope } from 'amtp-protocol'
import { openDb } from './db/open'
import { buildDeliveryHooks } from './hooks'
import { dbPath, ensureAmtpDirs } from './home'

let workDir: string
let home: string
let db: Database

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'amtp-hooks-test-'))
  home = join(workDir, 'home')
  ensureAmtpDirs(home)
  db = openDb(dbPath(home))
  db.run(
    `INSERT OR IGNORE INTO registrations (handle, inbound_open, agent_public_key_pem, agent_private_key_pem, created_at)
     VALUES (?, 0, 'unused-pub-key', 'unused-priv-key', ?)`,
    ['alice', Date.now()]
  )
})

afterEach(() => {
  db.close()
  rmSync(workDir, { recursive: true, force: true })
})

function makeEnvelope(overrides: Partial<AmtpEnvelope> = {}): AmtpEnvelope {
  return {
    v: 1,
    id: randomUUID(),
    ts: Date.now(),
    from: 'amtp://peer.example/bob',
    to: 'amtp://this.example/alice',
    content: 'hello',
    ...overrides,
  }
}

describe('onMessageReceived attachment filename sanitization', () => {
  test('strips path-traversal separators from a sender-controlled filename before it reaches the db', async () => {
    const hooks = buildDeliveryHooks(db, home)
    const envelope = makeEnvelope()

    await hooks.onMessageReceived({
      envelope,
      peerInstanceId: 'peer.example',
      senderHandle: 'bob',
      recipientRef: 'alice',
      agentSigVerified: false,
      attachments: [
        {
          ref: {
            id: 'wire-ref-1',
            filename: '../../../../tmp/traversal-probe.txt',
            contentType: 'text/plain',
            byteSize: 4,
            sha256: 'x'.repeat(64),
          },
          bytes: new Uint8Array([1, 2, 3, 4]),
        },
      ],
    })

    const message = db.query<{ id: string }, [string]>('SELECT id FROM messages WHERE envelope_id = ?').get(envelope.id)
    expect(message).not.toBeNull()
    const attachmentRow = db
      .query<{ filename: string }, [string]>('SELECT filename FROM attachments WHERE message_id = ?')
      .get(message!.id)
    expect(attachmentRow).not.toBeNull()
    expect(attachmentRow!.filename).not.toMatch(/[/\\]/)
    expect(attachmentRow!.filename).toBe('traversal-probe.txt')
  })
})
