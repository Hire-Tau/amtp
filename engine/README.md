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
  identity, peers, pins, replays, outbox, attachments, handles, policy, delivery,
  // ^ your AmtpEnginePorts implementations
})
const result = await engine.receiveEnvelope({ peerInstanceId, rawBody })
// -> { httpStatus, body } — frame it straight into your HTTP response
```

The `amtp` CLI is a thin host over this engine; the
[contract kit](src/contract-kit/) is how any host proves its ports conform.
Full walkthrough: the
[implementer's guide](https://github.com/Hire-Tau/amtp/blob/main/docs/implementers-guide.md).

Spec: [AMTP.md](https://github.com/Hire-Tau/amtp/blob/main/docs/SPEC.md).
Part of [Hire-Tau/amtp](https://github.com/Hire-Tau/amtp). MIT.

See [signed GET compatibility](../docs/compatibility.md) and [troubleshooting](../docs/troubleshooting.md).
