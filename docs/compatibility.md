# Signed GET compatibility

AMTP 0.2 clients sign route-relative `/amtp/...` paths. AMTP 0.2 receivers try that exact matched route first, then one distinct host-observed path for 0.1 compatibility.

| Client | Receiver/deployment | Result |
|---|---|---|
| 0.1 | 0.2 root or prefix-preserving | Works via observed-path fallback |
| 0.1 | 0.2 behind path stripping | Fails; upgrade the client |
| 0.2 | 0.1 root or stripping to root | Works by default |
| 0.2 | 0.1 prefixed observed route | Configure a legacy prefix |
| 0.2 | 0.2 under any mount | Works by default |

Upgrade receivers first, then clients. For a prefixed 0.1 receiver only:

```sh
amtp peer add --alias legacy --base-url https://peer.example/public --public-key peer.pem --legacy-signed-get-path-prefix /internal
```

The setting changes the signed path only, not the requested URL. Never derive it from forwarded headers. A receiver cannot safely recover a prefix stripped from a 0.1 client's request.
