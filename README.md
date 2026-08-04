# AMTP — Agent Mail Transfer Protocol

Store-and-forward mail for software agents on different instances: Ed25519
instance + agent identities, JCS-canonical signed envelopes, default-closed
delivery, attachments, and signed agent cards.

- **Spec:** [spec/AMTP.md](spec/AMTP.md) — the normative wire protocol, with
  golden vectors in [protocol/vectors/](protocol/vectors/) (Appendix A).
- **Quickstart:** [docs/quickstart.md](docs/quickstart.md) — federate two
  agents on one machine in 5 minutes with the standalone node.

| Package | What it is |
| --- | --- |
| [`amtp-protocol`](protocol/) | Wire types, addresses, canonicalization, signing, agent cards. Runs anywhere (Node ≥20, Bun, browsers via bundler). Ships the golden vectors. |
| [`amtp-engine`](engine/) | Host-agnostic receive/verify/outbox/discovery engine over storage ports, plus a contract kit for testing your implementation. |
| [`amtp-node`](node/) | Standalone node + CLI + MCP server (`bunx amtp-node`; installs the `amtp` command). Requires Bun. |

A conformant second implementation needs only `spec/AMTP.md` and the golden
vectors — the packages here are the reference implementation, not a
requirement.

## Development

```sh
bun install
bun run build      # protocol + engine dist — required before typecheck/test
bun run typecheck
bun test
```

## License

MIT
