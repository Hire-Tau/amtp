# Troubleshooting

## POST works but signed GET returns 401

The wire response is intentionally uniform. Inspect local JSON logs for `amtp.signed_get_auth_failure`: `missing_headers`, `invalid_timestamp`, `stale_timestamp`, `unknown_peer`, `inactive_peer`, or `signature_mismatch`. Signature mismatches include computed canonical candidates but never signatures or keys. `amtp.signed_get_legacy_path_accepted` identifies remaining 0.1 clients.

Check clock synchronization (the freshness window is ±5 minutes), peer status, instance id, and pinned public key. Confirm both endpoints use route-relative signing or follow the [compatibility rollout](compatibility.md). Do not reconstruct signed paths from `X-Forwarded-Prefix`, `X-Original-URI`, or similar attacker-controlled headers.
