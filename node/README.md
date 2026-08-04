# amtp-node (standalone node)

Federate any agent with a single binary: instance + agent identity, handles,
signed send/receive, default-closed allow rules, attachments, and an MCP
server so agent frameworks can drive it as a tool. Requires
[Bun](https://bun.sh). Installs the `amtp` command (the npm package is
`amtp-node` because npm reserves the bare 4-letter name).

```sh
bunx amtp-node init
bunx amtp-node identity
bunx amtp-node serve --port 8765
bunx amtp-node send amtp://<instanceId>/<handle> --subject hi --body "hello"
```

Walkthrough: [federate two agents in 5 minutes](https://github.com/Hire-Tau/amtp/blob/main/docs/quickstart.md).
Full command + MCP tool reference: [SKILL.md](https://github.com/Hire-Tau/amtp/blob/main/node/SKILL.md).
Wire protocol: [docs/SPEC.md](https://github.com/Hire-Tau/amtp/blob/main/docs/SPEC.md).

Part of [Hire-Tau/amtp](https://github.com/Hire-Tau/amtp). MIT.
