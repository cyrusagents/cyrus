# CYPACK-1546 registered engineering F1

The registered runtime now executes reviewed engineering assignments using the
existing generic SQLite occurrence ledger, durable session sink and contained
Codex adapter. Hosted envelope ACK4a96a3c4 and publication receipt ACK2d7841a9
are implemented in `docs/runtime-automations-v1.md`.

[Native drive evidence](evidence/registered-engineering/native.json) passes:

- Actual Codex app-server in the immutable Docker image, deterministic Responses
  transport, real MCP SDK initialize/list/call/reconnect, registered HTTP routes.
- Separate network-disabled engineering container: initially failing `node --test`,
  an edit retained across failure, model-directed repair, passing rerun.
- Reviewed snapshot publication: two calls, one immutable operation receipt after
  lost ACK; no local command replay during publication reconciliation.
- Assignment-only session with no customer grants or private sponsor parent.
- 102 durable activity receipts from107 deliveries,14 result commits from15 sends;
  existing direct/ticket delegation yields two children from five calls.
- Instructions, actual scheduled tick, admitted event queue/restart/dedup,
  current-authority denial and terminal result-only recovery remain covered.

Reproduce after `pnpm build`, with the reviewed local immutable image preloaded:

```sh
CYRUS_F1_CODEX_IMAGE=sha256:35ffa8e695666695f047cf527138b9b27f2e1c29d44673f9eb705a0e4010be4f \
node --input-type=module -e 'const {runAutomationDrive}=await import("./apps/f1/automation-drive.mjs"); console.log(JSON.stringify(await runAutomationDrive(),null,2));'
```

Use explicit `CYRUS_TEST_DOCKER_PATH`/`CYRUS_TEST_DOCKER_HOST` as supported by the
driver for a separately authorized same-user daemon. No credential copying,
network-enabled container, host mount or image pull is allowed. The image and
build/load instructions remain in `docs/contained-codex-image.md`.

The initial drive reached publication/final checkpoint but failed its fixture's
old one-tool session-count assertion. Engineering has three tool operations;
the assertion was corrected from7 to11 receipts and a fresh drive passed.
The [original failure log](evidence/registered-engineering/initial-fixture-failure.txt)
is retained; no production behavior was relaxed to pass it.

Additional validation:95 targeted runtime/MCP/session tests with real-image
engineering enabled; full edge-worker suite972 passed/13 opt-in skipped; separate
real-image executor4 passed including timeout, abort and output-limit stop.
Monorepo typecheck and edge-worker build passed. Commit hooks also run full build
and typecheck. SDK regressions reject forged authority/file arguments, foreign
assignment/repository/URL receipts, undeclared result fields, customer/remote-execute
catalog entries and revoked existing sessions. Uncertain receipts retain the
same supervisor snapshot/key across token rotation. Changed review/generation/files
on retry cannot open a new checkpoint.

This is controlled model/authority/provider transport evidence. Hosted SQL,
actual publication reconciliation/fanout, live preview UI and live Linear acceptance
remain separate joined gates. No live Slack acceptance, provider/model spend,
publication, merge, release or production enablement is claimed. There is no
published minimum cyrus-ai version. Rollback must preserve the new ledger and
receipts; disable new dispatch instead of pointing an old strict reader at them.
