// §4.8 `policy` (ReceivePolicy) — allow-rule matching delegates directly to
// the engine's exported reference matcher (`matchesAllowRule`), per §4.8's
// prescription that the node use it directly rather than re-deriving the
// predicate. Attachment caps come from `config.json` `receive.*` (§3.4),
// re-read per call with mtime-based caching so a live edit takes effect
// immediately without re-parsing on every single receive.
//
// Spec: docs/superpowers/specs/2026-07-08-amtp-node-design.md §4.8, §3.4.

import { readFileSync, statSync } from 'node:fs'
import type { Database } from 'bun:sqlite'
import { matchesAllowRule } from 'amtp-engine'
import type { ReceiveCaps, ReceivePolicy } from 'amtp-engine'
import { configPath } from '../home'

// §3.4 defaults — the reference host's INBOX_MAX_ATTACHMENT_BYTES / INBOX_MAX_TOTAL_STORAGE_BYTES defaults.
const DEFAULT_MAX_ATTACHMENT_BYTES = 10_485_760
const DEFAULT_MAX_TOTAL_STORAGE_BYTES = 10_737_418_240

const DEFAULT_CAPS: ReceiveCaps = {
  maxAttachmentBytes: DEFAULT_MAX_ATTACHMENT_BYTES,
  maxTotalStorageBytes: DEFAULT_MAX_TOTAL_STORAGE_BYTES,
}

interface AllowRuleRow {
  peer_instance_id: string
  principal_kind: 'any' | 'handle'
  principal_value: string | null
}

export function buildReceivePolicy(db: Database, home: string): ReceivePolicy {
  let cache: { mtimeMs: number; caps: ReceiveCaps } | null = null

  function readCaps(): ReceiveCaps {
    let mtimeMs: number
    try {
      mtimeMs = statSync(configPath(home)).mtimeMs
    } catch {
      // No config.json yet — defaults.
      return DEFAULT_CAPS
    }

    if (cache && cache.mtimeMs === mtimeMs) return cache.caps

    let caps: ReceiveCaps
    try {
      const parsed = JSON.parse(readFileSync(configPath(home), 'utf8')) as {
        receive?: { maxAttachmentBytes?: number; maxTotalStorageBytes?: number }
      }
      const receive = parsed.receive ?? {}
      caps = {
        maxAttachmentBytes:
          typeof receive.maxAttachmentBytes === 'number' ? receive.maxAttachmentBytes : DEFAULT_MAX_ATTACHMENT_BYTES,
        maxTotalStorageBytes:
          typeof receive.maxTotalStorageBytes === 'number'
            ? receive.maxTotalStorageBytes
            : DEFAULT_MAX_TOTAL_STORAGE_BYTES,
      }
    } catch {
      caps = DEFAULT_CAPS
    }

    cache = { mtimeMs, caps }
    return caps
  }

  return {
    async isReceiveAllowed({ recipientRef, peerInstanceId, senderHandle }) {
      const rules = db
        .query<
          AllowRuleRow,
          [string]
        >('SELECT peer_instance_id, principal_kind, principal_value FROM allow_rules WHERE handle = ?')
        .all(recipientRef)
      return rules.some((r) =>
        matchesAllowRule(
          { peerInstanceId: r.peer_instance_id, principalKind: r.principal_kind, principalValue: r.principal_value },
          { peerInstanceId, senderHandle }
        )
      )
    },

    async getReceiveCaps() {
      return readCaps()
    },
  }
}
