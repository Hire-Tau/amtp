// DDL + migration list for the amtp.db sqlite database.
//
// Spec: docs/superpowers/specs/2026-07-08-amtp-node-design.md §3.1, §3.3.
//
// `migrations[i]` is the DDL for schema version `i + 1` (i.e. `migrations[0]`
// is version 1). `open.ts` tracks the applied version via `PRAGMA
// user_version` and applies whichever migrations are missing.

// Migration 1 — transcribed verbatim from spec §3.1. All 8 tables plus the
// two partial unique indexes on allow_rules and the two secondary indexes on
// outbox/messages/attachments.
const migration1 = `
-- §4.1 InstanceIdentityPort. Single row, created by \`amtp init\`.
CREATE TABLE identity (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  instance_id     TEXT    NOT NULL,        -- AMTP.md §4.1 derivation of public_key_pem
  public_key_pem  TEXT    NOT NULL,        -- SPKI PEM
  private_key_pem TEXT    NOT NULL,        -- PKCS#8 PEM
  created_at      INTEGER NOT NULL
);

-- §4.2 PeerStore + CLI peer admin.
CREATE TABLE peers (
  instance_id    TEXT    PRIMARY KEY,
  alias          TEXT    NOT NULL UNIQUE,
  base_url       TEXT    NOT NULL,
  public_key_pem TEXT    NOT NULL,
  status         TEXT    NOT NULL DEFAULT 'active',
  created_at     INTEGER NOT NULL
);

-- §4.3 PinStore (TOFU). First write wins; never updated (AMTP.md §4.4).
CREATE TABLE pins (
  peer_instance_id TEXT    NOT NULL,
  handle           TEXT    NOT NULL,
  public_key_pem   TEXT    NOT NULL,
  created_at       INTEGER NOT NULL,
  PRIMARY KEY (peer_instance_id, handle)
);

-- §4.5 ReplayLedger. Pruned by serve maintenance (§5.2), never by the engine.
CREATE TABLE received (
  peer_instance_id TEXT    NOT NULL,
  envelope_id      TEXT    NOT NULL,
  received_at      INTEGER NOT NULL,
  PRIMARY KEY (peer_instance_id, envelope_id)
);

-- §4.8 HandleDirectory + per-handle agent identity (§9).
-- One instance identity, MANY local handles: single-identity multi-handle.
CREATE TABLE registrations (
  handle                TEXT    PRIMARY KEY,   -- ^[a-zA-Z0-9][a-zA-Z0-9_-]*$, len ≤ 200 (AMTP.md §3)
  inbound_open          INTEGER NOT NULL DEFAULT 0,
  agent_public_key_pem  TEXT    NOT NULL,      -- published at /amtp/agents/<handle>/key
  agent_private_key_pem TEXT    NOT NULL,      -- signs agentSig for sends from this handle (§9)
  created_at            INTEGER NOT NULL
);

-- §4.9 ReceivePolicy — same rule shape as the reference host (kinds 'any' | 'handle'),
-- evaluated with the engine's exported matchesAllowRule.
CREATE TABLE allow_rules (
  id               TEXT    PRIMARY KEY,
  handle           TEXT    NOT NULL REFERENCES registrations(handle) ON DELETE CASCADE,
  peer_instance_id TEXT    NOT NULL,
  principal_kind   TEXT    NOT NULL CHECK (principal_kind IN ('any', 'handle')),
  principal_value  TEXT,
  created_at       INTEGER NOT NULL,
  CHECK ((principal_kind = 'any'    AND principal_value IS NULL)
      OR (principal_kind = 'handle' AND principal_value IS NOT NULL))
);
-- UNIQUE with a NULL column would not dedupe in sqlite; use partial indexes:
CREATE UNIQUE INDEX allow_rules_any ON allow_rules (handle, peer_instance_id)
  WHERE principal_kind = 'any';
CREATE UNIQUE INDEX allow_rules_handle ON allow_rules (handle, peer_instance_id, principal_value)
  WHERE principal_kind = 'handle';

-- §4.6 OutboxStore. States mirror the reference amtp outbox machine.
CREATE TABLE outbox (
  id               TEXT    PRIMARY KEY,
  peer_instance_id TEXT    NOT NULL,
  to_address       TEXT    NOT NULL,
  envelope_json    TEXT    NOT NULL,           -- JSON of AmtpEnvelope (ts re-stamped at delivery)
  idempotency_key  TEXT    NOT NULL UNIQUE,
  status           TEXT    NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'delivering', 'delivered', 'failed')),
  attempts         INTEGER NOT NULL DEFAULT 0, -- completed attempts (pre-increment read by backoff, §4.6)
  next_attempt_at  INTEGER NOT NULL,
  claim_token      TEXT,
  claimed_at       INTEGER,
  last_error       TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX outbox_claim ON outbox (status, next_attempt_at);

-- Local mailbox: received messages AND dead-letter bounces in one table
-- (mirrors the reference host, where bounces land in the same inbox as remote mail —
-- apps/core/src/services/amtp/hooks.ts:101-120).
CREATE TABLE messages (
  id                 TEXT    PRIMARY KEY,
  kind               TEXT    NOT NULL CHECK (kind IN ('received', 'bounce')),
  handle             TEXT    NOT NULL REFERENCES registrations(handle) ON DELETE CASCADE,
                     -- received: local recipient handle; bounce: local authoring handle
  peer_instance_id   TEXT,                      -- received only
  from_address       TEXT    NOT NULL,          -- received: envelope.from; bounce: 'system'
  envelope_id        TEXT,                      -- received: remote envelope id; bounce: dead envelope id
  subject            TEXT,
  content            TEXT    NOT NULL,
  in_reply_to        TEXT,                      -- received only: envelope.inReplyTo
  agent_key          TEXT,                      -- received only: envelope.agentKey when present
  agent_sig_verified INTEGER NOT NULL DEFAULT 0,-- AMTP.md §4.5 advisory flag (surfaced, never gating)
  bounce_json        TEXT,                      -- bounce only: {"outboxId","envelopeId","toAddress","reason"}
                                                -- (the AMTP.md §9.4 federationBounce payload)
  received_at        INTEGER NOT NULL,
  read_at            INTEGER
);
CREATE INDEX messages_handle ON messages (handle, received_at DESC);

-- Attachment metadata for BOTH directions; blobs live on disk (§3.2).
--   direction 'in'  — pulled with a received message (message_id set).
--     \`id\` is a FRESH LOCAL UUID, NEVER the sender-chosen wire ref id (§4.9);
--     the wire ref id is not stored (filename/contentType/byteSize/sha256 are
--     the ref's meaningful content — the reference host likewise drops it).
--   direction 'out' — staged by \`amtp attach upload\` (message_id NULL).
--     \`id\` doubles as the wire pull id in outbound refs (AMTP.md §5: opaque).
--     Wire-pull-id-as-row-id applies to direction='out' rows ONLY.
CREATE TABLE attachments (
  id           TEXT    PRIMARY KEY,
  message_id   TEXT    REFERENCES messages(id) ON DELETE CASCADE,
  direction    TEXT    NOT NULL CHECK (direction IN ('in', 'out')),
  filename     TEXT    NOT NULL,
  content_type TEXT    NOT NULL,
  byte_size    INTEGER NOT NULL,
  sha256       TEXT    NOT NULL,               -- lowercase hex
  storage_path TEXT    NOT NULL,               -- relative to <home>/blobs/
  created_at   INTEGER NOT NULL
);
CREATE INDEX attachments_message ON attachments (message_id);
`

// v2 (agent cards, spec §4.6): the handle's published signed card, verbatim
// JSON (AmtpSignedAgentCard) — NULL when unpublished.
const migration2 = `ALTER TABLE registrations ADD COLUMN card_json TEXT;`

/**
 * Migration DDL, indexed by (version - 1): `migrations[0]` is version 1's
 * DDL, `migrations[1]` is version 2's, etc.
 */
export const migrations: string[] = [migration1, migration2]
