# CYPACK-1546: measured session execution duration

The optional negotiated lifecycle pair `executionDurationMs` and
`executionDurationComplete` reports observed cumulative execution across attempts.
It never subtracts receipt or creation timestamps. The private session journal
persists monotonic samples and marks a crash-truncated interval incomplete; queue,
offline, admission and receipt waits do not contribute. See the exact negotiation
and lifecycle contract in `docs/runtime-automations-v1.md`.

Validation on 2026-09-30:

- Lifecycle/runtime tests cover measured failed work plus resumed work, a day
  offline, slow admission/delivery, crash heartbeat recovery, fencing, foreign
  journals, downgrade denial, old payload compatibility and strict duration bounds.
- Root, direct-child and ticket-backed completion receipts retain their exact
  measured payload/digest through lost completion ACK and result-only recovery.
- Registered HTTP/SQLite/SDK MCP F1 passes for Messages and contained Codex.
  Two actual 25-second model turns measured 50,026 ms (Messages) and 51,175 ms
  (native), while ten credential renewals retained one session and successful reads.
- Native: 136 distinct activity receipts/141 deliveries, 18 result commits/19 sends,
  two children/five delegation calls, one engineering publication/two calls,
  five scope denials. Legacy fixture admissions retain lifecycle payloads without
  timing fields. Lost-result-ACK replays do not change terminal duration.
- Existing recovery, diagnostics, MCP, contained-model and engineering regressions:
  35 passed, two opt-in skips. The native F1 exercises the immutable container.

Reproduce after `pnpm build`:

```sh
pnpm --filter cyrus-edge-worker test:run test/session-execution-timing.test.ts test/session-delivery.test.ts test/session-outbox.test.ts test/automations.test.ts
node apps/f1/automation-drive.mjs
CYRUS_F1_CODEX_IMAGE=sha256:35ffa8e695666695f047cf527138b9b27f2e1c29d44673f9eb705a0e4010be4f node apps/f1/automation-drive.mjs
```

Use `CYRUS_TEST_DOCKER_HOST`/`CYRUS_TEST_DOCKER_PATH` for an explicitly owned test
engine. Evidence: `evidence/cypack-1546-execution-timing-{messages,native}-summary.json`.
All model/provider/Hosted transports here are controlled fixtures. Actual Hosted
SQL persistence/UI and live preview duration acceptance remain the Hosted/verifier
join; no live process, occurrence or provider was changed. Image and production
TLS/containment requirements are unchanged. No release or registry publication.
