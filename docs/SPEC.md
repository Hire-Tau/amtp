# AMTP v1 — Agent Mail Transfer Protocol

## 1. Status & scope

This document is the normative specification of AMTP version 1, a
store-and-forward mail protocol for exchanging messages between software
agents hosted on different **instances**. It is kept byte-compatible with the
reference implementation in this repository, which is not otherwise
normative — everything an implementer needs is in this document and the golden
vectors of Appendix A.

This is the implementer's guide — the wire protocol itself. If you just want
to run an existing node and federate an agent, see the operator-facing
[federate-in-5-minutes quickstart](./quickstart.md) and
[`node/SKILL.md`](../node/SKILL.md) instead.

AMTP covers: addressing, instance and agent identity, the message envelope,
transport authentication, authorship signatures, the receive pipeline,
sender retry/bounce semantics, attachment transfer, and peer discovery.
It does not cover how an instance stores, renders, or routes messages
internally after acceptance.

Transport is HTTPS. All routes in this document are relative to a peer's
**base URL** (written `<base>`). A host MAY mount the AMTP routes under any
URL prefix. Signed GET requests use proxy-stable AMTP route-relative paths
(§6.2), so a mount prefix is not a signing input. The key words MUST, MUST NOT, SHOULD, SHOULD NOT,
and MAY are to be interpreted as described in RFC 2119 (§2).

## 2. Terminology

- **RFC 2119 keywords** — MUST, MUST NOT, REQUIRED, SHALL, SHOULD, SHOULD
  NOT, MAY are used as defined in RFC 2119.
- **Instance** — one deployment speaking AMTP. It holds exactly one Ed25519
  instance keypair and is named by its self-certifying instance id (§4.1).
- **Peer** — a remote instance that the local instance has explicitly
  trusted by recording its instance id, base URL, and public key (§4.2). A
  peer record has a status; only `active` peers are authenticated.
- **Handle** — the local name of an agent's mailbox on an instance, unique
  per instance.
- **Address** — `amtp://<instanceId>/<handle>`; globally names one agent
  mailbox (§3).
- **Envelope** — the JSON message unit posted between instances (§5).
- **Mailbox** — the inbound endpoint state of a registered agent handle: it
  may be *open* (accepts any peered sender) or closed with per-sender
  **allow rules**.
- **Allow rule** — a receiver-side grant admitting envelopes from a specific
  peer (any handle, or one named handle) to a specific local agent (§8 step 6).
- **Outbox** — the sender-side durable queue of envelopes awaiting delivery
  (§9).
- **Pin** — a trust-on-first-use record binding a remote `(peer, handle)`
  pair to an agent public key (§4.4).
- **Bounce** — the local failure notice delivered to the sending agent when
  an envelope is abandoned as undeliverable (§9.4).

## 3. Addressing

An AMTP address has the exact form:

```
amtp://<instanceId>/<handle>
```

Grammar, applied to the string after the literal prefix `amtp://`:

- The characters before the first `/` are the `instanceId`; the characters
  after it are the `handle`.
- Both parts MUST be non-empty.
- The handle MUST be exactly one path segment: it MUST NOT contain `/`.
- Neither part may contain whitespace, where "whitespace" is exactly the set
  matched by the ECMAScript `RegExp` `\s` character class, defined
  constructively as: U+0009 (TAB), U+000A (LF), U+000B (VT), U+000C (FF),
  U+000D (CR), U+0020 (SPACE), U+00A0 (NBSP), U+FEFF (ZWNBSP/BOM), every
  code point in Unicode general category Zs (U+1680, U+2000–U+200A, U+202F,
  U+205F, U+3000), and the line terminators U+2028 and U+2029. Note this is
  NOT the Unicode `White_Space` property: the set **includes** U+FEFF (which
  `White_Space` excludes) and **excludes** U+0085 NEXT LINE (which
  `White_Space` includes) — U+0085 is therefore permitted in an address.

A parser MUST reject (treat as not-an-address) any string that violates the
grammar, including: missing prefix, missing `/` separator, empty instance
id, empty handle, extra path segments, or embedded whitespace (per the `\s`
definition above). Appendix A's `addresses.json` enumerates accepted and
rejected forms, including a U+FEFF handle (rejected) and a U+0085 handle
(accepted).

The grammar itself does not constrain the alphabet further; interoperable
instance ids are the base64url values of §4.1. Instances SHOULD restrict
handles they register to `^[a-zA-Z0-9][a-zA-Z0-9_-]*$` with length ≤ 200 (the
reference implementation enforces this at registration); handles MUST NOT
contain `/` or whitespace, or the resulting address is unparseable.

## 4. Identity & trust

### 4.1 Instance identity

Each instance holds one Ed25519 keypair. The public key is interchanged as
an SPKI PEM string (`-----BEGIN PUBLIC KEY-----` …); the private key SHOULD
be stored as PKCS#8.

The instance id is self-certifying:

```
instanceId = base64url( SHA-256( SPKI DER of the public key ) )
```

where `base64url` is the URL-safe alphabet **without padding** (43
characters for a 32-byte digest). Given a claimed public key, any party can
recompute the instance id; an id therefore commits to its key. Appendix A's
`instance-identity.json` pins this derivation.

### 4.2 Peering

Peering is a mutual, out-of-band act: each operator records the other
instance's `instanceId`, `baseUrl`, and `publicKeyPem`, and marks the peer
`active`. There is no in-protocol handshake.

`GET <base>/amtp/identity` is the public, unauthenticated bootstrap read for
this exchange. It returns:

```json
{ "instanceId": "<base64url id>", "publicKeyPem": "<SPKI PEM>" }
```

The payload deliberately contains no handles or other enumeration data
(§11). A recipient of this payload MUST verify that `instanceId` equals the
§4.1 derivation of `publicKeyPem` before recording the peer. The reference
implementation enforces this at peer registration: `POST <base>/amtp/peers`
recomputes the §4.1 derivation from the submitted `publicKeyPem` and
responds `400` if it does not equal the submitted `instanceId`, or if the
`publicKeyPem` cannot be parsed as a key. The same check applies whenever an
existing peer's `publicKeyPem` is updated: the derivation of the new key
MUST equal the peer's (immutable) `instanceId`.

Requests from instances that are not recorded as `active` peers MUST be
rejected (§6). Deactivating a peer therefore severs both directions of
authenticated traffic without deleting its key.

### 4.3 Agent identity

Each agent MAY hold its own Ed25519 keypair, distinct from the instance key.
The agent's public key is interchanged as an SPKI PEM string (the envelope's
`agentKey` field, §5) and published by its home instance at:

```
GET <base>/amtp/agents/<handle>/key
```

This route is public (unauthenticated). It returns
`{ "handle": string, "instanceId": string, "identityPublicKey": "<SPKI PEM>" }`
for a registered handle with a published key, and 404 otherwise. Agents
MUST NOT hold the instance private key; instance-signed operations are
performed by the instance on the agent's behalf.

### 4.4 Trust-on-first-use pinning

The first time a receiving instance accepts a **signed** envelope (one
carrying `agentKey`) from a given `(peerInstanceId, handle)` pair, it MUST
fetch that handle's published key from the peer's key endpoint (§4.3) and
record it as the **pin** for the pair. If the key endpoint cannot be reached
or returns no key, the receiver MUST fail closed with a retryable error
before consuming the envelope's dedup slot (§8 step 7).

On every subsequent signed envelope from that pair, the envelope's
`agentKey` MUST equal the pinned key byte-for-byte; a mismatch MUST be
rejected with HTTP 403. v1 defines no key rotation: clearing a pin is an
out-of-band operator action.

### 4.5 What authorship verification means

A receiver marks an envelope *agent-signature-verified* when (a) `agentKey`
matches the pin and (b) `agentSig` verifies over the canonical bytes of §7
with the pinned key. This asserts exactly: *the envelope's bound fields were
authored by a holder of the key pinned for this sender at first contact.*

It does **not** assert that the pinned key was legitimately bound to a
particular person or agent at first contact (§12.1), that the remote
operator is honest, or that the content is safe. An envelope whose
`agentKey` matches the pin but whose `agentSig` is absent or fails to verify
is still delivered, flagged as unverified; the flag is advisory and MUST be
surfaced to the consuming agent, but MUST NOT by itself cause rejection.

### 4.6 Agent cards

An agent MAY publish a **card**: self-described metadata for its handle.

```
AgentCard   = { "name"?: string, "description"?: string, "extensions"?: object }
SignedCard  = { "v": 1, "instanceId": string, "handle": string,
                "card": AgentCard, "cardSig": string }
```

`name` MUST be ≤ 200 characters; `description` MUST be ≤ 2000 characters;
`name` and `description`, when present, MUST be non-empty. `extensions` is
an open JSON object for non-standard fields.

The compact JSON serialization of the SignedCard — no insignificant
whitespace, the form `JSON.stringify` produces (not the canonical JCS form
used for signing) — MUST be ≤ 16384 UTF-8 bytes; publishers MUST enforce
this limit at publication time. Receivers MUST reject a card whose received
representation exceeds this limit, and MAY additionally verify the limit
against a compact re-serialization.

Receivers MUST ignore unknown fields inside `card` for interpretation, but
they remain part of the signed bytes (below).

**Signature.** `cardSig` is a detached Ed25519 signature (base64, standard
alphabet, padded) by the agent's identity key (§4.3) over:

```
signingInput = UTF8("amtp-agent-card-v1") || 0x00
               || UTF8(JCS({ "v": 1, "instanceId": ..., "handle": ..., "card": ... }))
```

where JCS is the RFC 8785 JSON Canonicalization Scheme, applied to exactly
those four members in the object `{v, instanceId, handle, card}`. Binding
`instanceId` and `handle` into the payload prevents replaying a card onto
another identity or handle. Verification MUST canonicalize the card value as
received (including unknown members).

**Serving.**

```
GET <base>/amtp/agents/<handle>/card
→ 200 { "v": 1, "instanceId": ..., "handle": ..., "card": ..., "cardSig": ... }
→ 404 when the handle is unknown or has published no card
```

The route is public (unauthenticated), like §4.3. Servers MUST serve the
card verbatim as published by the agent and MUST NOT re-sign it. A server
MUST stop serving a card when its handle is unregistered or when the
agent's identity key changes (the signature no longer verifies).

**Verifying.** Consumers MUST verify `cardSig` against the pinned identity
key for `(instanceId, handle)` (§4.4 pinning applies; first contact MAY pin
via §4.3). Consumers MUST also check that the received `instanceId` and
`handle` match the peer and handle for which the card was requested. On any
failure — size, schema, binding, signature — the card MUST be treated as
absent. §4.5's trust ceiling applies unchanged: a verified card proves
authorship by the pinned key holder, not honesty.

## 5. Envelope

An envelope is a single JSON object. Field set (no other semantics are
attached to unknown fields; see §13):

| Field         | Type                | Required | Semantics                                                                                          |
| ------------- | ------------------- | -------- | -------------------------------------------------------------------------------------------------- |
| `v`           | integer literal `1` | yes      | Protocol version. Any other value MUST be rejected with 400 (§13).                                  |
| `id`          | string, non-empty   | yes      | Sender-generated envelope id (the reference uses UUIDv4). Replay/dedup key, scoped per sending peer (§8 step 8). MUST NOT change across retries. |
| `ts`          | number              | yes      | Milliseconds since the Unix epoch. Re-stamped by the sender at each delivery attempt (§9.2); freshness-checked by the receiver (§8 step 3). |
| `from`        | string, non-empty   | yes      | Sender's AMTP address (§3). Its instance id MUST match the transport-authenticated peer (§8 step 4). |
| `to`          | string, non-empty   | yes      | Recipient's AMTP address (§3). Its instance id MUST match the receiving instance (§8 step 5).        |
| `subject`     | string, non-empty   | no       | Message subject. When present it MUST be non-empty.                                                 |
| `content`     | string, non-empty   | yes      | Message body.                                                                                       |
| `inReplyTo`   | string, non-empty   | no       | Envelope id of the message being replied to. Threading hint; not covered by `agentSig` (§7).        |
| `attachments` | array of refs       | no       | Attachment references (below). Blobs travel out of band (§10).                                      |
| `agentKey`    | string, non-empty   | no       | Authoring agent's Ed25519 public key, SPKI PEM (§4.3). Presence makes the envelope "signed" for §4.4/§8 step 7. |
| `agentSig`    | string, non-empty   | no       | Base64 (standard alphabet, padded) Ed25519 signature over the canonical bytes of §7.                |

Each element of `attachments` is:

| Field         | Type                 | Required | Semantics                                                              |
| ------------- | -------------------- | -------- | ---------------------------------------------------------------------- |
| `id`          | string, non-empty    | yes      | Opaque pull identifier, resolvable at the **sender's** attachment route (§10). Not covered by `agentSig`. |
| `filename`    | string, non-empty    | yes      | Suggested filename.                                                     |
| `contentType` | string, non-empty    | yes      | MIME type of the blob.                                                  |
| `byteSize`    | integer ≥ 0          | yes      | Exact blob length in bytes; verified after pull (§10.3).                |
| `sha256`      | string, non-empty    | yes      | Lowercase hex SHA-256 of the blob bytes; verified after pull (§10.3).   |

The envelope has no canonical serialization on the wire: the sender
serializes it as any valid JSON, signs those exact bytes (§6.1), and the
receiver MUST verify the transport signature against the raw received body
bytes before parsing. Only the `agentSig` subset (§7) has a canonical byte
form.

## 6. Transport signatures

All instance-to-instance requests are authenticated with the sending
instance's Ed25519 key, verified against the key the receiver pinned at
peering time (§4.2). Signatures are transmitted base64-encoded (standard
alphabet, with padding). Every authentication failure MUST be a uniform
HTTP 401 with no distinguishing detail (no oracle for peer existence, peer
status, or which check failed).

### 6.1 POST (envelope delivery)

`POST <base>/amtp/inbox` with `content-type: application/json` and headers:

| Header             | Value                                                             |
| ------------------ | ----------------------------------------------------------------- |
| `x-amtp-instance`  | Sender's instance id (§4.1).                                       |
| `x-amtp-signature` | Base64 Ed25519 signature over the **exact raw request body bytes**. |

The signed message is the request body, byte for byte — not a parsed or
re-serialized form. The receiver MUST: reject with 401 if either header is
missing, if `x-amtp-instance` is not an `active` peer, or if the signature
does not verify over the raw body with that peer's pinned instance key.
Verification failures of any kind (malformed key, malformed signature) MUST
yield 401, never a 5xx.

There is no timestamp header on POST; freshness is enforced on the
envelope's `ts` field. The receiver MUST reject envelopes where
`|now − ts| > 300000` ms (±5 minutes) with HTTP 400. Senders MUST re-stamp
`ts` to the current time at each delivery attempt (§9.2) so queue age never
violates the window; persistent 400s here indicate clock skew, and
instances SHOULD keep clocks synchronized (e.g. NTP) well within ±5 minutes.
Appendix A's `envelope-signature.json` pins body-byte signing.

### 6.2 GET (bodyless authenticated reads)

Signed GETs (`/amtp/handles`, `/amtp/attachments/<id>`) carry:

| Header             | Value                                                        |
| ------------------ | ------------------------------------------------------------ |
| `x-amtp-instance`  | Caller's instance id.                                         |
| `x-amtp-signature` | Base64 Ed25519 signature over the canonical string below.     |
| `x-amtp-timestamp` | Decimal milliseconds since the Unix epoch, as signed.          |

The canonical string is exactly three lines joined by `\n` (LF, 0x0A), UTF-8
encoded, with no trailing newline:

```
METHOD
PATH
TIMESTAMP_MS
```

- `METHOD` is the uppercase HTTP method (`GET`).
- `PATH` is the AMTP route-relative URL pathname: `/amtp/handles` or
  `/amtp/attachments/<id>`. The attachment id retains its exact `URL.pathname`
  spelling; it is not decoded or normalized. Scheme, authority, peer base-URL
  mount prefix, query, and fragment are excluded. During the 0.2 transition a
  receiver MUST try the exact matched route first and MAY then try one
  byte-distinct host-observed pathname for 0.1 clients. It MUST NOT search
  suffixes or reconstruct prefixes from forwarded headers. A client talking
  to a prefixed 0.1 receiver MAY prepend an explicitly configured local
  compatibility prefix to the signed path without changing the requested URL.
- `TIMESTAMP_MS` is the decimal integer also sent in `x-amtp-timestamp`.

The receiver MUST reject with a uniform 401 when: any header is missing,
the timestamp is non-numeric or `|now − timestamp| > 300000` ms, the caller
is not an `active` peer, or the signature does not verify over the canonical
string. Responses MUST remain identical for every failure. Receivers SHOULD log local structured failure reasons without signatures or key material. Appendix A's `get-canonical.json` pins the canonical string and signatures; `get-path-derivation.json` pins path derivation.

## 7. Canonical byte strings (agent authorship)

`agentSig` signs a canonical serialization of a fixed subset of the
envelope. Signer and verifier MUST produce identical bytes. Construction:

1. Take the fields `v`, `id`, `from`, `to`, `subject`, `content`,
   `attachments`.
2. Trim the subject (remove leading/trailing Unicode whitespace, as
   ECMAScript `String.prototype.trim`). If the subject is absent, or empty
   after trimming, it is **omitted** from the canonical object.
3. Reduce each attachment to exactly the keys
   `{filename, contentType, byteSize, sha256}` in that key order, dropping
   `id` and any other keys. Sort the reduced attachments ascending by their
   `sha256` string (UTF-16 code-unit order; for lowercase hex digests this
   equals byte order). The sort MUST be stable: attachments with equal
   `sha256` values preserve their envelope order. If there are no
   attachments, the `attachments` key is **omitted** entirely.
4. Assemble an object with keys in exactly this order:
   `v, id, from, to, (subject), content, (attachments)` — parenthesized keys
   present only per rules 2–3.
5. Serialize as JSON with no insignificant whitespace, using ECMAScript
   `JSON.stringify` string escaping (escape only `"`, `\`, and control
   characters U+0000–U+001F, using the short forms `\"`, `\\`, `\b`, `\f`,
   `\n`, `\r`, `\t` where they exist and `\u00XX` otherwise; unpaired
   surrogates as `\uXXXX`; all other characters, including non-ASCII,
   emitted literally). Integers serialize in shortest decimal form.
6. UTF-8 encode. These are the signed bytes.

Excluded from the subset — and therefore mutable in transit without
invalidating authorship: `ts` (re-stamped at every delivery attempt, §9.2),
`inReplyTo`, attachment `id`s (sender-local pull identifiers), and
`agentKey`/`agentSig` themselves.

Rationale: the signature is **replay-stable authorship**. It binds who said
what to whom (`from`, `to`, `content`, `subject`) and the exact attachment
content digests, while surviving the retry mechanics (re-stamped
timestamps) and storage-local identifiers that legitimately differ between
the signing and verifying sides. Attachment sorting makes the signature
independent of array order. Appendix A's `agent-signature.json` pins every
rule above, including whitespace-only-subject omission and digest-order
sorting.

## 8. Receive pipeline (normative ordering)

A receiving instance MUST process `POST <base>/amtp/inbox` in exactly this
order. Steps 1–7 MUST all complete before the dedup slot (step 8) is
consumed: a rejected envelope never burns its id, so an attacker who
observes an envelope id cannot poison future delivery, and fail-closed
rejections retry cleanly.

1. **Transport authentication** (§6.1). Failure → 401 (uniform).
2. **Parse and validate.** Parse the raw body as JSON, then validate the
   envelope schema of §5 (required fields present, types correct, `v` = 1,
   non-empty strings non-empty). Failure → 400.
3. **Freshness.** `|now − ts| > 300000` ms → 400.
4. **From-integrity.** Parse `from` per §3; its `instanceId` MUST equal the
   transport-authenticated peer's instance id. Failure → 400. A peer MUST
   NOT be able to originate mail claiming another instance.
5. **Recipient resolution.** Parse `to` per §3 (failure → 400). `to`'s
   `instanceId` MUST equal the receiving instance's own id, and the handle
   MUST resolve to a registered local agent; either failure → 404
   (uniformly "recipient not found", so foreign-instance addressing and
   unknown handles are indistinguishable).
6. **Policy gate (default-deny).** The envelope is admitted iff the
   recipient is registered (has a handle) AND the sending peer is still a
   known peer AND (the recipient's mailbox is open OR an allow rule
   matches: rule peer = sending peer AND (rule kind is `any`, or rule kind
   is `handle` and its value equals the sender's handle)). Otherwise → 403.
7. **Agent authorship** — only when `agentKey` is present:
   1. If no pin exists for `(peer, sender handle)`: fetch the published key
      (§4.3) and pin it. If the peer record has vanished → 403. If the
      fetch fails for any reason (network, non-2xx, missing key in body),
      the receiver MUST fail **closed** with a retryable **502** — before
      the dedup claim — rather than deliver unverified. (Failing open would
      let anyone who can disrupt or time the key endpoint force an
      unverified first message through and burn its dedup slot.)
   2. If a pin exists and the envelope's `agentKey` differs from it → 403
      (§4.4).
   3. If `agentSig` is present, verify it over the §7 bytes with the pinned
      key. The outcome is the advisory verified flag (§4.5); a failed
      verification MUST NOT reject the envelope.
8. **Replay dedup.** Atomically record `(peerInstanceId, id)` if unseen. If
   already seen → respond 200 `{"accepted": true, "duplicate": true}`
   without re-delivering. The dedup key is scoped per peer.
9. **Attachment pull** — only when `attachments` is non-empty (§10). On any
   failure the receiver MUST roll back partial state, release the step-8
   dedup record so the sender's retry is a fresh first sighting, and
   respond per the table below.
10. **Local delivery.** Persist the message for the recipient agent. On a
    persistence failure, release the dedup record and → 502. Persistence is
    the durability boundary: once the message row (and any linked
    attachment blobs) is committed, the envelope is accepted regardless of
    what happens next — a subsequent failure to wake or push the message to
    a live agent session is best-effort and MUST NOT change the response or
    release the dedup record.
11. **Acknowledge** → 200 `{"accepted": true}`.

Response semantics, from the sender's viewpoint (§9.3: retryable = 408,
429, and ≥ 500; every other non-2xx is terminal):

| Status | Emitted at step | Meaning                                             | Sender action |
| ------ | --------------- | ---------------------------------------------------- | ------------- |
| 200    | 8, 11           | Accepted (possibly `duplicate: true`).               | Done.         |
| 400    | 2, 3, 4, 5      | Malformed/stale envelope, forged or invalid address. | Terminal.     |
| 401    | 1               | Transport authentication failed (uniform).           | Terminal.     |
| 403    | 6, 7            | Policy denial or pinned-key mismatch.                | Terminal.     |
| 404    | 5               | Recipient not found (uniform).                       | Terminal.     |
| 413    | 9               | An attachment exceeds the receiver's per-item cap.   | Terminal.     |
| 422    | 9               | Attachment failed sha256/byteSize verification.      | Terminal.     |
| 502    | 7, 9, 10        | Key endpoint unreachable, pull failed, or persistence failed. | Retry. |
| 507    | 9               | Receiver storage quota exhausted.                    | Retry.        |

## 9. Sender / outbox expectations

Senders MUST deliver through a durable queue with the following observable
behavior. Internal mechanics (claim tokens, workers) are quality-of-
implementation; the retry arithmetic below records the reference defaults
and is SHOULD-level unless marked MUST.

### 9.1 Enqueue idempotency

Each outbound envelope is enqueued under an idempotency key; re-enqueueing
the same key MUST return the existing queue entry rather than creating a
duplicate. The envelope `id` is fixed at enqueue time and MUST never change
thereafter.

### 9.2 Delivery attempt

Each attempt POSTs the envelope to `<peerBase>/amtp/inbox` per §6.1. At
each attempt the sender MUST re-stamp `ts` to the current time (so a queue
delay or peer outage longer than the ±5-minute window never permanently
strands mail) and MUST keep `id` unchanged (it is the receiver's dedup
nonce). The body is re-serialized and re-signed each attempt. The reference
uses a 10 s response timeout, raised to 60 s for envelopes with attachments
(the receiver pulls blobs synchronously inside the ack window, §10).

Concurrent delivery workers MUST NOT double-send a queue entry; the
reference claims entries atomically and treats a claim older than 5 minutes
as abandoned and reclaimable.

An "attempt" is an actual delivery POST to the peer. A claim that is
skipped without a POST — for example because the peer is not `active` at
drain time — is requeued and does NOT count toward the retry bound of
§9.3; such an entry may be retried indefinitely until the peer becomes
active or is removed.

### 9.3 Outcome classification

| Result of attempt                    | Classification                        |
| ------------------------------------ | -------------------------------------- |
| 2xx                                  | Delivered.                             |
| 408, 429, or ≥ 500                   | Retryable failure.                     |
| Any other non-2xx (4xx)              | Terminal — dead-letter immediately.    |
| Network error / timeout              | Retryable failure.                     |

Retryable failures MUST be retried with backoff; the reference uses
exponential backoff `min(5000 · 2^min(attempts, 16), 300000)` ms. Retries
MUST be bounded: after a maximum attempt count (reference: 16) the entry is
dead-lettered.

### 9.4 Dead-letter bounce

When an entry is dead-lettered (terminal 4xx, or retry budget exhausted),
the sending instance MUST notify the local authoring agent with a bounce
message in its local inbox stating that delivery to the destination address
failed permanently, the reason, the attempt count, and the original
envelope id (and subject when present). The bounce message MUST carry
machine-readable metadata under the key `federationBounce`:

```json
{ "federationBounce": { "outboxId": "...", "envelopeId": "...", "toAddress": "amtp://.../...", "reason": "..." } }
```

The bounce is a purely local message addressed to a local agent — never to
an `amtp://` address — so it cannot re-enter the outbox (loop-safe by
construction). Bounce delivery is best-effort: its failure MUST NOT undo
the terminal state or abort other queue processing.

## 10. Attachments

### 10.1 Model

Attachment blobs never travel in the envelope. The envelope carries
metadata references (§5); after accepting the envelope's dedup claim, the
**receiver pulls** each blob from the **sender** with a signed GET (§6.2):

```
GET <senderBase>/amtp/attachments/<id>
```

A successful response is 200 with the raw blob bytes, `content-type` and
`content-length` headers.

### 10.2 Serving (sender side) — default-deny

The serving instance MUST authenticate the pull per §6.2 and MUST serve an
attachment id only to a peer to which it has actually addressed that
attachment — i.e. the id appears in the `attachments` of a queued or sent
envelope destined for the requesting peer. Every failure — unauthorized
peer, unknown id, id not sent to this peer, blob missing from storage —
MUST be a uniform 404, so existence is not leaked. (Authentication-header
failures are 401 per §6.2, which precedes the id lookup.)

### 10.3 Pulling (receiver side) — verify then accept

For each reference, the receiver:

1. SHOULD reject before any network call if `byteSize` exceeds its
   per-attachment cap (→ 413 to the original POST) or if the aggregate
   `byteSize` sum would exceed its storage quota (→ 507). Caps are receiver
   policy, not protocol constants.
2. Pulls the blob; any non-2xx or network failure → 502 (retryable).
3. MUST verify the received byte length equals `byteSize` and the SHA-256
   of the received bytes equals `sha256` (lowercase hex). Either mismatch →
   422 (terminal): the envelope signature (§7) bound these digests, so a
   mismatch means the sender is serving different content than was signed.

On any failure the receiver MUST NOT deliver a partial message: all blobs
pull and verify, or none of the message is visible to the recipient agent,
the dedup record is released, and the error is returned (§8 step 9).

## 11. Discovery

`GET <base>/amtp/handles`, authenticated per §6.2, returns the handles the
instance publishes:

```json
{ "handles": [ { "handle": "support",
                 "name": "Support Concierge",
                 "description": "Handles inbound customer questions" } ] }
```

`name` and `description` are OPTIONAL, UNSIGNED display hints subject to the
§4.6 field caps. The list is peer-authenticated transport, not agent-signed:
consumers MUST NOT treat hints as verified and SHOULD fetch the §4.6 card
for authoritative values. Servers SHOULD derive hints from the handle's
published card. Receivers MUST ignore hint fields exceeding the caps.

Discovery requires an established, active peering: the public identity
payload (§4.2) deliberately excludes handles, so anonymous parties cannot
enumerate an instance's agents. Per-handle key lookup (§4.3) is public but
requires knowing the handle.

## 12. Threat model

v1's security goals and accepted limitations:

1. **First-pin forgery (accepted).** Agent-key pinning is trust-on-first-
   use. The peer's operator controls the key endpoint, so at first contact
   it can bind any key to any of its handles. `agentSig` therefore proves
   *continuity* — later messages authored by the same key as the first —
   not initial identity. Operators MAY verify first pins out-of-band where
   this matters.
2. **No key rotation (accepted).** A pin mismatch is always a 403 (§4.4).
   Recovering from a lost or compromised agent key requires out-of-band
   operator action on the receiving side. A silent key swap after first
   contact is thereby always detected.
3. **Transport confidentiality is assumed.** AMTP signatures authenticate
   but do not encrypt; deployments MUST use TLS. The ±5-minute freshness
   windows (§6) bound replay of captured requests only in concert with TLS;
   signed GETs are idempotent reads, and envelope replay inside the window
   is absorbed by dedup (§8 step 8).
4. **Key custody.** The instance private key MUST NOT leave the instance
   and MUST NOT be exposed to agents; agent identity keys SHOULD be held in
   per-agent private storage inaccessible to other agents.
5. **Fail-closed verification.** A receiver MUST NOT deliver a signed
   envelope it cannot verify because the sender's key endpoint is
   unavailable (§8 step 7); it answers 502 without consuming the dedup
   slot.
6. **No error oracles.** Transport-auth failures are uniform 401s;
   recipient resolution failures are uniform 404s; attachment-serve denials
   are uniform 404s.
7. **Rate limiting (deferred).** v1 defines no rate limits. Future versions
   are expected to add per-peer inbound rate limits signaled with 429 —
   already classified retryable (§9.3) — so conformant v1 senders degrade
   gracefully when limits appear.

## 13. Versioning

`v` is the envelope's protocol version and is the integer `1` in this
specification. A receiver MUST reject any envelope whose `v` is not a
version it implements with HTTP 400 (in v1, schema validation — §8 step 2 —
already rejects `v ≠ 1`).

Within v1.x, evolution is additive-optional only:

- New fields MUST be optional, and receivers MUST ignore unknown envelope
  fields and unknown response-body fields rather than reject them.
- Senders MUST NOT require a peer to understand an optional field for the
  message to be meaningful.
- Any change to the canonical byte constructions (§6.2, §7), the signature
  algorithms, the instance-id derivation (§4.1), or the meaning of existing
  fields requires a new major version and a new `v` value. In particular
  the `agentSig` subset (§7) is frozen for `v: 1`: fields added within v1.x
  are never covered by it.

## Appendix A. Golden vectors

The files under `protocol/vectors/` (published as `amtp-protocol/vectors/*.json`) are the normative, machine-
readable companion to this document. **An implementation is conformant with
the byte-level constructions of this specification iff it reproduces every
vector byte-for-byte** — same canonical strings, same derived ids, same
signatures from the given private keys, same accept/reject outcomes. The
reference implementation executes them in
`protocol/src/spec-vectors.test.ts`; a second implementation
SHOULD wire the same JSON into its own test suite. All keys in the vector
files are throwaway fixtures generated for the vectors; they MUST NOT be
used operationally.

| File                      | Section | Contract                                                                 |
| ------------------------- | ------- | ------------------------------------------------------------------------ |
| `addresses.json`          | §3      | Address grammar.                                                          |
| `instance-identity.json`  | §4.1    | Instance-id derivation.                                                   |
| `envelope-signature.json` | §6.1    | Transport signing of raw body bytes.                                      |
| `agent-signature.json`    | §7      | Canonical agent-signature bytes.                                          |
| `get-canonical.json`      | §6.2    | Canonical GET string.                                                     |
| `get-path-derivation.json`| §6.2    | Proxy-stable signed-path derivation.                                      |
| `agent-card.json`         | §4.6    | Canonical agent-card signing bytes and `cardSig`.                         |

**`addresses.json`.** `valid` entries map an input address to its parsed
`{instanceId, handle}`; a conformant parser MUST produce exactly that pair,
and formatting the pair MUST round-trip to the input string. Every string
in `invalid` MUST fail to parse.

**`instance-identity.json`.** Each entry pairs an SPKI `publicKeyPem` with
its `instanceId`. A conformant implementation MUST derive exactly that id
from the PEM per §4.1 (unpadded base64url of the SHA-256 of the SPKI DER).

**`envelope-signature.json`.** `keys` holds an Ed25519 keypair and its
derived `instanceId`. Each vector gives `bodyUtf8` — the exact request body
string — and `signatureB64`. Signing the UTF-8 bytes of `bodyUtf8` with the
private key MUST yield exactly `signatureB64`; verification with the public
key MUST succeed, and MUST fail for any altered byte. (Ed25519 signatures
are deterministic, so byte-equality of signatures is well-defined.)

**`agent-signature.json`.** Each vector gives `fields` — an input to the §7
construction — plus the expected `canonicalUtf8` and `signatureB64`. A
conformant implementation MUST produce exactly `canonicalUtf8` from
`fields` (the vectors exercise subject present, absent, needing trim, and
whitespace-only-omitted, and out-of-order attachments that MUST re-sort by
`sha256`), and signing those bytes with the file's private key MUST yield
exactly `signatureB64`.

**`get-canonical.json`.** Each vector gives `method`, `path`, `timestampMs`, the expected
`canonicalUtf8`, and `signatureB64`. A conformant implementation MUST build
exactly `canonicalUtf8` and reproduce the signature with the file's private
key.


**`get-path-derivation.json`.** Each vector derives the signed path from a peer base URL, AMTP route, and optional explicit legacy prefix. Mount prefixes do not affect the default result.
