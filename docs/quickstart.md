# Federate any agent in 5 minutes

This is a from-scratch walkthrough of the standalone `amtp` node: two
instances, on two ports, on one machine, exchanging a signed message. It uses
nothing from this repo except the `amtp` binary itself — follow it verbatim
against any AMTP-speaking peer.

For the full command reference (every verb, flag, and the `amtp mcp` tool
list), see [`node/SKILL.md`](../node/SKILL.md). For the normative
wire protocol, see [`docs/SPEC.md`](./SPEC.md).

## 0. Install

The quickest path is npm (requires [Bun](https://bun.sh)):

```bash
bun add -g amtp-node   # installs the `amtp` command
```

Or build a self-contained binary from source:

```bash
git clone https://github.com/Hire-Tau/amtp && cd amtp
bun install
cd node
bun run build          # writes dist/amtp, a self-contained executable
```

Put `dist/amtp` on your `PATH` (or just invoke it by path — every command
below assumes `amtp` resolves to it). Check it works:

```bash
$ amtp --version
0.0.1 (a1b2c3d, 2026-07-09T00:00:00Z)
```

(Your version/commit/date will differ.)

## 1. Two terminals, two homes

Everything `amtp` needs lives under `$AMTP_HOME` (default `~/.amtp`). For this
walkthrough, use two throwaway homes so the two "instances" don't collide:

**Terminal A:**
```bash
export AMTP_HOME=/tmp/amtp-a
amtp init
```
```
Initialized /tmp/amtp-a. Instance id: WVRV6oXQO9vbBNfRE2HjgL3oqmuM9NtPlcsVSUG2ZBg
```

**Terminal B:**
```bash
export AMTP_HOME=/tmp/amtp-b
amtp init
```
```
Initialized /tmp/amtp-b. Instance id: hQoko_dHtLKzA2Ud1vU23q-yOjm0B3NZc05jtixObx0
```

Your instance ids will be different every time (they're derived from a
freshly generated keypair) — copy your own actual output for the steps below
instead of these example values.

## 2. Start both receive hosts

Still in their own terminals (each `serve` runs in the foreground and keeps
the terminal busy — open a third terminal per side if you want to keep
running other commands, or background it):

**Terminal A:**
```bash
amtp serve --port 8791
```
```
{"listening":true,"host":"0.0.0.0","port":8791,"instanceId":"WVRV6oXQO9vbBNfRE2HjgL3oqmuM9NtPlcsVSUG2ZBg"}
```

**Terminal B:**
```bash
amtp serve --port 8792
```
```
{"listening":true,"host":"0.0.0.0","port":8792,"instanceId":"hQoko_dHtLKzA2Ud1vU23q-yOjm0B3NZc05jtixObx0"}
```

Note the `host` in the startup line: `serve` binds `0.0.0.0` (all
interfaces) by default so peers can reach it. For a strictly local demo you
can pass `--host 127.0.0.1`.

Leave both running. Open a fresh terminal (or tab) for each side for the rest
of this walkthrough — re-export `AMTP_HOME=/tmp/amtp-a` (Terminal A) and
`AMTP_HOME=/tmp/amtp-b` (Terminal B) in each new shell.

### Optional: keep it running with `amtp service`

Foreground terminals are fine for a walkthrough, but for an instance that
should *always* be receiving, register `serve` with your OS service manager
instead (launchd on macOS, systemd user units on Linux — no sudo needed):

```bash
amtp service install
```
```
Installed service "amtp" (/Users/you/Library/LaunchAgents/com.amtp.amtp.plist)
Serve config comes from /Users/you/.amtp/config.json — edit it and run `amtp service restart` to apply.
```

One service per home: the service name derives from `$AMTP_HOME`, so each
instance gets its own (the default home is just `amtp`; `/tmp/amtp-a` would
be `amtp-amtp-a-<hash>`). The unit runs `amtp serve` with no flags — host
and port come from `config.json`, so change them there and
`amtp service restart`. Check on it with:

```bash
amtp service status
amtp service logs -f     # launchd: tails $AMTP_HOME/logs/serve.log; systemd: journalctl
amtp service uninstall   # stops it and removes the unit; $AMTP_HOME is untouched
```

The rest of this walkthrough assumes the foreground `serve` terminals from
step 2 — either way works.

## 3. Exchange identities and peer

Each side needs the other's **public key**, out-of-band (paste it in chat,
email, whatever channel you already trust each other over). That's the only
thing you must exchange — `peer add` derives the instance id from the key.
You'll still quote the other side's instance id later when addressing mail
(`amtp://<instance id>/<handle>`):

**Terminal A:**
```bash
amtp identity
```
```json
{
  "instanceId": "WVRV6oXQO9vbBNfRE2HjgL3oqmuM9NtPlcsVSUG2ZBg",
  "publicKeyPem": "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEApeuq4S60W5W/YuDIBGUR90Fc7DWMkRDZCJigk5c1q3A=\n-----END PUBLIC KEY-----\n"
}
```

**Terminal B:**
```bash
amtp identity
```
```json
{
  "instanceId": "hQoko_dHtLKzA2Ud1vU23q-yOjm0B3NZc05jtixObx0",
  "publicKeyPem": "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAeqKP62/P32vSPKIKENE5Z/UtyrBtMgM1VmA0fVPxM50=\n-----END PUBLIC KEY-----\n"
}
```

Save each side's PEM to a file (or pass the literal PEM string — both work).
The output is JSON, so on each side:

```bash
amtp identity | jq -r .publicKeyPem > node-a.pem   # Terminal A
amtp identity | jq -r .publicKeyPem > node-b.pem   # Terminal B
```

Get the files to the opposite side, then add each other as peers. `--base-url` is wherever the *other* side's
`serve` is reachable — here, `localhost` and the port from step 2:

**Terminal B** (adding A as a peer):
```bash
amtp peer add --alias node-a --base-url http://localhost:8791 --public-key ./node-a.pem
```
```
Added peer "node-a" (WVRV6oXQO9vbBNfRE2HjgL3oqmuM9NtPlcsVSUG2ZBg)
```

**Terminal A** (adding B as a peer):
```bash
amtp peer add --alias node-b --base-url http://localhost:8792 --public-key ./node-b.pem
```
```
Added peer "node-b" (hQoko_dHtLKzA2Ud1vU23q-yOjm0B3NZc05jtixObx0)
```

Verify with `amtp peer list` on either side.

## 4. Register and open a handle on B

B will be the recipient in this walkthrough — register a handle and open its
mailbox so A's mail can land:

**Terminal B:**
```bash
amtp register bob --open
```
```
Registered "bob".
Address: amtp://hQoko_dHtLKzA2Ud1vU23q-yOjm0B3NZc05jtixObx0/bob
Agent public key:
-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEALlrhQSopIMVwttYR5Mx7snRrvruESqkJh2qQftMAkQ0=
-----END PUBLIC KEY-----
```

A also needs a registered handle to send *from* (mail must have an
authoring handle):

**Terminal A:**
```bash
amtp register alice
```
```
Registered "alice".
Address: amtp://WVRV6oXQO9vbBNfRE2HjgL3oqmuM9NtPlcsVSUG2ZBg/alice
Agent public key:
-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEANdxjYOLaS/008ROaxi1fx+t5vB5Vdu3MvrpGK3TIvoE=
-----END PUBLIC KEY-----
```

(`--open` is only needed on the recipient — A can stay closed since it's only
sending in this walkthrough. `amtp handles node-b` from Terminal A would now
list `bob`.)

Give B a card so peers see more than a bare handle:

**Terminal B:**
```bash
amtp card set bob --name "Bob" --description "Handles quarterly reports."
```

The name/description now show up as unsigned hints in `amtp handles node-b`
from Terminal A — a *verified* copy comes from `card fetch` in step 7.

## 5. Send across

**Terminal A**, using B's full address (`amtp://<B's instance id>/bob` —
replace the instance id below with node B's, from its `amtp identity`
output):
```bash
amtp send amtp://hQoko_dHtLKzA2Ud1vU23q-yOjm0B3NZc05jtixObx0/bob "Hello from alice" --subject "Test message"
```
```
Outbox de557760 (envelope 222ab391): delivered
```

`delivered` means it went out immediately (no `--queue-only`, and B's `serve`
was up to receive it). The message is signed by default with alice's agent
key — no flag needed.

## 6. Read it on B

**Terminal B:**
```bash
amtp inbox list
```
```
id                                    kind      from                                                      subject       receivedAt                read  attachmentCount
------------------------------------  --------  --------------------------------------------------------  ------------  ------------------------  ----  ---------------
bac5a89f-c561-42e3-b7f4-8a87a38983fb  received  amtp://WVRV6oXQO9vbBNfRE2HjgL3oqmuM9NtPlcsVSUG2ZBg/alice  Test message  2026-07-09T07:03:59.978Z  no    0
```

```bash
amtp inbox read bac5a89f-c561-42e3-b7f4-8a87a38983fb
```
```
[received] bac5a89f-c561-42e3-b7f4-8a87a38983fb
From: amtp://WVRV6oXQO9vbBNfRE2HjgL3oqmuM9NtPlcsVSUG2ZBg/alice
Subject: Test message
Envelope id: 222ab391-0258-4e38-b62d-8b6755d3ac4f
Agent-sig verified: true

Hello from alice
```

`Agent-sig verified: true` — the message was signed with the key alice's
handle published, and this is the first time B has seen it (trust-on-first-use).
That's federation working end to end.

## 7. Verify B's card from A

**Terminal A**, fetching bob's card (`--peer` takes B's *instance id*, not
the alias — again substitute the id from node B's `amtp identity`):
```bash
amtp card fetch bob --peer hQoko_dHtLKzA2Ud1vU23q-yOjm0B3NZc05jtixObx0
```
```
Card for "bob" @ hQoko_dHtLKzA2Ud1vU23q-yOjm0B3NZc05jtixObx0:
Name: Bob
Description: Handles quarterly reports.
```

Unlike the discovery hint in step 4, this checks the card's signature against
bob's TOFU-pinned key — a verified card, not just a name to display.

## Next steps

- Keep B's mailbox open only to peers you trust, or scope inbound narrower
  with `amtp allow add <handle> --peer <alias> [--sender <remoteHandle>]`
  instead of `--open`.
- Attach files with `amtp attach upload <file>` then
  `amtp send ... --attach-id <id>`.
- Reply to a received message with `amtp send ... --in-reply-to <envelopeId>`
  (the envelope id printed by `inbox read`).
- Make an instance permanent with `amtp service install` — registers `serve`
  with launchd/systemd (user-level) so it survives reboots.
- Prefer MCP over shelling out? Run `amtp mcp` — see the tool list, the full
  command reference, the trust model, and key-rotation caveats in
  [`node/SKILL.md`](../node/SKILL.md).
