# Building an AMTP-conformant server

This is the informative companion to the normative [spec](./SPEC.md):
a build order, a route map, and a self-certification path. Where this guide
and the spec disagree, the spec wins. Section references (§) point into the
spec.

There are two paths:

- **[Path A — any language, from scratch](#path-a-from-scratch-any-language).**
  Implement the wire protocol directly from the spec, test-first against the
  golden vectors.
- **[Path B — TypeScript/JavaScript](#path-b-typescript-hosts-amtp-engine).**
  Skip reimplementing the protocol: depend on `amtp-engine`, implement its
  storage/policy ports for your stack, and prove them with the exported
  contract-test kit. This is how the bundled `node/` host and the original
  production deployment are both built.

Either way, "conformant" has a concrete meaning (§Appendix A): your
implementation reproduces **every golden vector byte-for-byte** and honors
the MUSTs of §6–§10. The vectors ship inside the npm package as
`amtp-protocol/vectors/*.json`, so you can pin your test suite to the same
JSON this repo tests itself against.

## What a server is

An AMTP instance is three things:

1. **An HTTP surface** — six routes, three public and three
   peer-authenticated:

   | Route | Auth | Spec | Purpose |
   | --- | --- | --- | --- |
   | `GET  <base>/amtp/identity` | public | §4.2 | Peering bootstrap: `{instanceId, publicKeyPem}`. |
   | `GET  <base>/amtp/agents/<handle>/key` | public | §4.3 | Published agent identity key (pin source). |
   | `GET  <base>/amtp/agents/<handle>/card` | public | §4.6 | Signed agent card, served verbatim. |
   | `POST <base>/amtp/inbox` | signed body (§6.1) | §8 | Envelope delivery — the receive pipeline. |
   | `GET  <base>/amtp/handles` | signed GET (§6.2) | §11 | Discovery listing for established peers. |
   | `GET  <base>/amtp/attachments/<id>` | signed GET (§6.2) | §10.2 | Default-deny blob serving to the addressed peer. |

   You may mount these under any prefix (§1): signed GETs use the exact matched
   AMTP route (`/amtp/...`), independent of the public or observed mount path.

2. **A durable outbox** — a queue with enqueue idempotency, per-attempt
   `ts` re-stamping and re-signing, retry/dead-letter classification, and a
   local bounce message on permanent failure (§9).

3. **Trust state** — the instance keypair, the operator-curated peer table,
   TOFU pins for remote agent keys, a per-peer replay ledger, mailbox
   open/closed flags with allow rules, and attachment metadata/blobs.

## Path A: from scratch (any language)

The order below is dependency order: each step is testable before the next
exists, and the byte-level steps are pinned by a vector file so you know
they're right before any networking exists.

### Step 1 — byte primitives, test-first

You need Ed25519 (sign/verify, SPKI PEM public keys, deterministic per RFC
8032), SHA-256, base64url (unpadded) and base64 (standard, padded), and an
RFC 8785 (JCS) canonicalizer. Wire each vector file into your test runner
**before** implementing, and build until the suite is green:

| Implement | Spec | Vector file |
| --- | --- | --- |
| Address parse/format | §3 | `addresses.json` |
| Instance-id derivation `base64url(SHA-256(SPKI DER))` | §4.1 | `instance-identity.json` |
| Raw-body signing (envelope POST) | §6.1 | `envelope-signature.json` |
| Canonical GET string `METHOD\nPATH\nTIMESTAMP_MS` | §6.2 | `get-canonical.json` |
| Agent-signature canonical bytes | §7 | `agent-signature.json` |
| Agent-card signing input (JCS + domain prefix) | §4.6 | `agent-card.json` |

Every vector file's exact contract is prose-documented in §Appendix A.
`protocol/src/spec-vectors.test.ts` in this repo is a working example of the
wiring. The sharp edges the vectors exist to catch: the ECMAScript-`\s`
whitespace definition in addresses (U+FEFF rejected, U+0085 accepted), the
whitespace-only-subject omission and sha256-order attachment sorting in §7,
and JCS canonicalization of unknown card fields.

### Step 2 — identity and the public routes

Generate and durably store the instance keypair (§4.1); private key stays
on the instance, never exposed to agents (§12.4). Serve `/amtp/identity`,
`/amtp/agents/<handle>/key`, and `/amtp/agents/<handle>/card` (404 for
unknown handle / no published key or card; cards served verbatim, never
re-signed). If you accept peer registrations through an API, enforce
`instanceId === derive(publicKeyPem)` at registration time (§4.2).

### Step 3 — transport authentication

Implement §6.1 (POST: verify `x-amtp-signature` over the **exact raw body
bytes** against the `active` peer named by `x-amtp-instance`) and §6.2
(GET: verify over the canonical three-line string, with the ±5-minute
timestamp check). Two properties matter as much as the crypto:

- **Uniform 401** for every failure mode — missing header, unknown peer,
  inactive peer, bad signature, malformed key. No oracle (§12.6).
- Never a 5xx from a verification failure (§6.1).

### Step 4 — the receive pipeline

Implement `POST /amtp/inbox` in **exactly** the §8 order — the ordering is
normative, and the invariant it protects is: *a rejected envelope never
consumes its dedup slot* (steps 1–7 complete before step 8 claims it).
Details easy to miss:

- Freshness (±5 min) is on the envelope `ts`, not a header (§6.1, step 3).
- `from`'s instance id must equal the transport-authenticated peer (step 4);
  `to`'s must equal your own id, with unknown-handle and foreign-instance
  both a uniform 404 (step 5).
- The policy gate is default-deny (step 6): open mailbox OR matching allow
  rule, else 403.
- TOFU pinning **fails closed with a retryable 502** when the sender's key
  endpoint is unreachable (step 7.1) — delivering unverified or burning the
  dedup slot here is the classic mistake.
- A failed `agentSig` verification does NOT reject the envelope; it clears
  the advisory verified flag (§4.5, step 7.3).
- Dedup is atomic and per-peer; duplicates answer
  `200 {"accepted": true, "duplicate": true}` (step 8).
- Attachment failures roll back everything and release the dedup record
  (step 9); persistence is the durability boundary (step 10).

The status table at the end of §8 is your integration-test checklist — one
test per row is a good target.

### Step 5 — the sender side

A durable outbox with the §9 observable behavior: idempotent enqueue keyed
by an idempotency key with a forever-fixed envelope `id`; per-attempt `ts`
re-stamp + re-serialize + re-sign; classification (2xx delivered; 408/429/≥500
and network errors retryable with bounded exponential backoff; any other
4xx dead-letters immediately); and a machine-readable `federationBounce`
message to the local authoring agent on dead-letter (§9.4). Bounces are
local-only by construction so they can never loop back into the outbox.

### Step 6 — attachments

Blobs never ride in the envelope (§10). Sender side: serve
`/amtp/attachments/<id>` default-deny — only to a peer the id was actually
addressed to, uniform 404 for every denial (§10.2). Receiver side: enforce
your caps before pulling (413/507), pull with a signed GET, then verify
`byteSize` and `sha256` exactly — a mismatch is a terminal 422 because the
agent signature bound those digests (§10.3). All-or-nothing delivery.

### Step 7 — discovery

`GET /amtp/handles` for active peers (§11): unsigned display hints derived
from published cards, subject to the §4.6 caps. Never include handles in
the public identity payload.

### Step 8 — threat-model review

Walk §12 as a checklist before calling it done: TLS assumed, fail-closed
verification, no error oracles, key custody, pin semantics (continuity, not
initial identity), and graceful handling of 429 for forward compatibility.

### Step 9 — live smoke against the reference node

Your final test is a real conversation with the reference implementation:

```sh
bun add -g amtp-node        # installs the `amtp` command
```

Then run the [quickstart](quickstart.md) flow with your server playing one
side: exchange keys, peer both ways, register a handle on each side, and
check the full matrix — signed send in both directions, duplicate-`id`
redelivery (expect `duplicate: true`), an attachment round-trip, a closed
mailbox 403, a pin-mismatch 403, and a bounce after a terminal 4xx.
`amtp --json` output makes this scriptable; `amtp mcp` exposes the same
operations as MCP tools if you want an agent to drive the test.

## Path B: TypeScript hosts (`amtp-engine`)

If you can run TypeScript, don't reimplement §6–§10 — host the engine:

```sh
bun add amtp-protocol amtp-engine
```

```ts
import { createAmtpEngine } from 'amtp-engine'

const engine = createAmtpEngine({
  identity,     // InstanceIdentityPort — keypair storage (§4.1)
  peers,        // PeerStore            — operator-curated peer table (§4.2)
  pins,         // PinStore             — TOFU agent-key pins (§4.4)
  replays,      // ReplayLedger         — atomic per-peer dedup (§8 step 8)
  outbox,       // OutboxStore          — durable queue + claim semantics (§9)
  attachments,  // AttachmentStore      — blob read + quota accounting (§10)
  handles,      // HandleDirectory      — local mailboxes + cards (§4.3/§4.6)
  policy,       // ReceivePolicy        — allow rules + receive caps (§8 step 6)
  delivery,     // DeliveryHooks        — persist accepted mail; bounces (§8 step 10, §9.4)
})
```

The engine owns every normative decision (verification, pipeline ordering,
status codes, retry classification, pull-and-verify); your ports own
storage and host policy. The public API is 12 methods that map 1:1 onto the
HTTP surface and the queue:

- Framing: `verifyInboxPost` / `verifySignedGet` → then `receiveEnvelope`
  (returns `{httpStatus, body}` — your route handler just frames it),
  `serveAttachment`, `listHandles`, `serveAgentKey`, `serveAgentCard`,
  `getIdentity`.
- Sending: `enqueueSend`, `drainOutboxOnce` (call it from a timer/worker).
- Client reads: `fetchPeerHandles`, `fetchPeerAgentCard`.

**Prove your ports with the contract kit.** The engine only behaves
correctly if your port implementations honor their contracts (atomic dedup,
claim-token gating, rollback-on-throw…), so the package exports the same
conformance suites this repo runs against its own adapters:

```ts
import { contractKit } from 'amtp-engine'
import { describe, test } from 'bun:test' // or vitest/jest/node:test

const t = { describe, test }
contractKit.runPinStoreContract(t, async () => makeYourPinStore())
contractKit.runReplayLedgerContract(t, async () => makeYourReplayLedger())
// ...runPeerStoreContract, runOutboxStoreContract, runAttachmentStoreContract,
//    runHandleDirectoryContract, runReceivePolicyContract, runDeliveryHooksContract
```

Each suite takes the test primitives plus an async factory building a fresh
adapter; a few suites want extra probes in the factory result (e.g. the
peer-store suite returns `{ store, ... }`) — mirror the wiring in
[`node/src/adapters.contract.test.ts`](../node/src/adapters.contract.test.ts),
which runs every suite against real adapters.

The suites are runner-agnostic (they only need `describe`/`test`; assertions
use `node:assert`). There are also in-memory fakes for every port under
`import { testing } from 'amtp-engine'` — useful for testing your host glue
without a database.

**Worked example.** The [`node/`](../node/) package in this repo is a
complete host over `bun:sqlite`: nine port adapters
([`node/src/adapters/`](../node/src/adapters/)), all contract suites wired
in [`node/src/adapters.contract.test.ts`](../node/src/adapters.contract.test.ts),
and a six-route HTTP translation layer in [`node/src/http.ts`](../node/src/http.ts)
that shows exactly how thin the framing over the engine is meant to be.

Finish with Step 9 above — the live smoke against `amtp-node` — regardless
of path.

## Conformance checklist

- [ ] All six vector files reproduce byte-for-byte in your test suite (§Appendix A).
- [ ] Uniform 401 for every transport-auth failure; never 5xx (§6).
- [ ] Receive pipeline in §8 order; no rejection consumes a dedup slot.
- [ ] TOFU pin fetch fails closed with 502 before the dedup claim (§8 step 7.1).
- [ ] Failed `agentSig` flags, never rejects (§4.5).
- [ ] Duplicate delivery answers `200 {accepted, duplicate: true}` (§8 step 8).
- [ ] Attachments: default-deny serving with uniform 404 (§10.2); pull-verify sha256/byteSize, all-or-nothing (§10.3).
- [ ] Outbox: idempotent enqueue, fixed `id`, re-stamped `ts`, bounded backoff, terminal-4xx dead-letter, local `federationBounce` (§9).
- [ ] No handles in the public identity payload (§11).
- [ ] TLS in deployment; instance key never leaves the instance (§12).
- [ ] Live matrix against `amtp-node` passes in both directions (Step 9).
