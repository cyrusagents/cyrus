# Review App metadata fallback

Tested Cyrus commit `927a1d8e4` using the existing
[CYPACK-1636 review webhook driver](2026-11-11-cypack-1636-review-suggestions.md).
Built with `pnpm --filter 'cyrus-edge-worker...' build` and ran a temporary copy
of the driver with `bun run`. The simulated App endpoint returned 403 when
Authorization was present and 200 for the same public metadata without it.

The real F1 /github-webhook route started exactly one recording runner session
and acknowledged once for the allowed review with two inline findings.
Duplicate, opted-out, disabled, cross-org and empty reviews did not start
sessions. The test used a synthetic GitHub API, a recording runner, and a
temporary Cyrus home. It did not exercise a live delivery or run a model.
