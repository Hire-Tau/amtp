# amtp-engine

Host-agnostic AMTP v1 engine: the receive/verify/outbox/discovery state
machines from the spec, over pluggable storage ports — bring your own
database, filesystem, or memory. Includes a contract kit that verifies your
port implementations behave correctly, plus in-memory fakes for tests.

```sh
npm i amtp-engine   # or: bun add amtp-engine
```

```ts
import { createAmtpEngine } from 'amtp-engine'

const engine = createAmtpEngine({
  identity, peers, pins, outbox, replay, handles, attachments, hooks,
  // ... your AmtpEnginePorts implementations
})
const result = await engine.receive(envelope, caps)
```

The `amtp` CLI is a thin host over this engine; the
[contract kit](src/contract-kit/) is how any host proves its ports conform.

Spec: [AMTP.md](https://github.com/Hire-Tau/amtp/blob/main/spec/AMTP.md).
Part of [Hire-Tau/amtp](https://github.com/Hire-Tau/amtp). MIT.
