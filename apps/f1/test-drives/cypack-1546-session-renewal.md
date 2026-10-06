# CYPACK-1546: MCP references across slow model turns

The live failure was a list/read loop: every slow model turn outlasted credential renewal, creating a new MCP session and invalidating the reference the model had just received. A previous fixture delayed only one turn and then responded quickly, so it missed repeated slow turns.

The additive negotiated contract in `docs/runtime-automations-v1.md` keeps the exact SDK session only after Hosted explicitly acknowledges same-session renewal. Without negotiation rotation still reconnects; missing/mismatched acknowledgement fails closed. No provider ID remapping or pending-write identity changes.

Validation on 2026-09-30:

- Focused automation/read-set/MCP/recovery suite: 59 passed, 1 opt-in skipped.
- SDK transport regression: four simulated 90-second model turns, eight renewals; same references read successfully. Both legacy and negotiated initialize/slow-write serialization and immutable lost-ACK reconciliation pass. Forged session acknowledgement, changed attempt, expired credential, missing continuation acknowledgement, real reconnect, foreign results and revocation deny.
- Registered HTTP/SQLite/MCP Messages and native Docker F1 drives pass. Each slow scenario includes two actual 25-second model responses against 20-second credentials and multiple renewal cycles, followed by successful reads. Native uses the existing immutable Codex image; all provider/model/Hosted transports are controlled fixtures.
- The initial long-delay F1 attempt uncovered an aggregate-count assertion race with an unrelated scheduled tick. The fixture now waits for the exact occurrence and pauses the already-verified schedule before later slow scenarios. This was fixture cleanup aborting the slow occurrence, not a lease-renewal failure.

Reproduce after `pnpm build`:

```sh
pnpm --filter cyrus-edge-worker test:run test/customer-read-set-mcp.test.ts test/automation-mcp.test.ts test/automations.test.ts test/automation-recovery.test.ts
node apps/f1/automation-drive.mjs
CYRUS_F1_CODEX_IMAGE=sha256:35ffa8e695666695f047cf527138b9b27f2e1c29d44673f9eb705a0e4010be4f node apps/f1/automation-drive.mjs
```

Optional explicit test daemon/binary use `CYRUS_TEST_DOCKER_HOST` and `CYRUS_TEST_DOCKER_PATH`. Production TLS validation is unchanged; fixture transport maps only the fixed synthetic origin to loopback.

Evidence: `evidence/cypack-1546-session-renewal-{messages,native}-summary.json`. These drives are not actual Hosted SQL/provider or live preview acceptance. Hosted must implement/acknowledge the matching atomic session renewal contract and pass the joint test before verifier-owned live testing. No live occurrence was retried and no preview process was changed.
