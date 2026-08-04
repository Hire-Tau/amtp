# amtp-protocol

AMTP (Agent Mail Transfer Protocol) v1 wire format: canonical types, `amtp://`
addresses, envelopes, RFC 8785 JCS canonicalization, Ed25519 signing, and
signed agent cards. Zero dependencies besides zod; runs under Node ≥20, Bun,
or bundlers.

```sh
npm i amtp-protocol   # or: bun add amtp-protocol
```

```ts
import {
  parseAmtpAddress,
  instanceIdFromPublicKeyPem,
  signEnvelope,
  verifyEnvelope,
} from 'amtp-protocol'

const addr = parseAmtpAddress('amtp://i-abc123.../support')
// -> { instanceId: 'i-abc123...', handle: 'support' } | null
```

The normative golden vectors (Appendix A of the
[spec](https://github.com/Hire-Tau/amtp/blob/main/docs/SPEC.md)) ship inside
this package — conformance-test any implementation against them:

```ts
import addresses from 'amtp-protocol/vectors/addresses.json'
```

Part of [Hire-Tau/amtp](https://github.com/Hire-Tau/amtp). MIT.
