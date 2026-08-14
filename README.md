# AMTP — Agent Mail Transfer Protocol

Store-and-forward mail for software agents on different instances: Ed25519
instance + agent identities, JCS-canonical signed envelopes, default-closed
delivery, attachments, and signed agent cards.

- **Spec:** [docs/SPEC.md](docs/SPEC.md) — the normative wire protocol, with
  golden vectors in [protocol/vectors/](protocol/vectors/) (Appendix A).
- **Quickstart:** [docs/quickstart.md](docs/quickstart.md) — federate two
  agents on one machine in 5 minutes with the standalone node.

| Package | What it is |
| --- | --- |
| [`amtp-protocol`](protocol/) | Wire types, addresses, canonicalization, signing, agent cards. Runs anywhere (Node ≥20, Bun, browsers via bundler). Ships the golden vectors. |
| [`amtp-engine`](engine/) | Host-agnostic receive/verify/outbox/discovery engine over storage ports, plus a contract kit for testing your implementation. |
| [`amtp-node`](node/) | Standalone node + CLI + MCP server (`bunx amtp-node`; installs the `amtp` command). Requires Bun. |

A conformant second implementation needs only `docs/SPEC.md` and the golden
vectors — the packages here are the reference implementation, not a
requirement. To build your own server (in any language, or by hosting
`amtp-engine`), start with the
[implementer's guide](docs/implementers-guide.md).

## Claude Code Skill

If a Claude session will operate an AMTP node (sending/receiving federated
mail, managing peers and handles via the `amtp` CLI), install the bundled
skill:

```bash
curl -fsSL https://raw.githubusercontent.com/Hire-Tau/amtp/main/contrib/claude-skills/install.sh | bash
```

Or from a checkout: `bash contrib/claude-skills/install.sh`. Skills land in
`~/.claude/skills/` (override with `CLAUDE_SKILLS_DIR`); re-run to update.

The skill's source of truth is [`node/SKILL.md`](node/SKILL.md) (shipped in
the `amtp-node` npm package); the contrib copy is generated from it by
`bun scripts/generate-contrib-skill.ts` (CI fails if they drift).

## Development

```sh
bun install
bun run build      # protocol + engine dist — required before typecheck/test
bun run typecheck
bun test
```

## License

MIT

See [signed GET compatibility](docs/compatibility.md) and [troubleshooting](docs/troubleshooting.md).
