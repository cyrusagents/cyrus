# CYPACK-1635: CI failure continuation

Run: 2026-11-10, repeated after rebasing on main `325010bd` (SDK update).
Implementation commit: `a199d74f`. Script: `apps/f1/github-ci-routing-drive.mjs`.
Scope: actual local HTTP endpoint, EdgeWorker transport registration, existing
AgentSessionManager sessions, and actual `prepareCiPrompt` streaming path.
GitHub API and the runner are deterministic fixtures. No live provider or model.

After `pnpm build`, run `node apps/f1/github-ci-routing-drive.mjs`.
The script uses a temporary Cyrus home and ephemeral loopback port and cleans both.

Assertions passed:

- Wrong runtime Bearer token: 401, neither session receives a prompt.
- Semaphore-style failed status for the current PR head: 200/accepted with
  `sessionId: responsible`; exactly one stream prompt containing status context
  and head SHA. The unrelated branch's session receives nothing.
- Redelivery: duplicate_revision, no second stream message.
- Stale SHA: no_current_pr, no second stream message.

Output: `PASS: actual HTTP -> EdgeWorker -> responsible session stream;
unauthorized/stale/duplicate deliveries do not dispatch. Runner/API are fixtures.`

The cross-checkout Hosted handoff fixture separately covers both Semaphore status
and GitHub Actions check payloads through the Hosted forwarder and real runtime
transport/router. Unit tests cover idle issue/GitHub continuation and failure paths.
Actual model execution, provider delivery and user-facing activity rendering remain
unverified; this is deterministic routing/session delivery evidence, not a CI fix.

## Follow-up: XML and live opt-in

Repeated 2026-11-11 with a single worker, transport and session runner. Uses the
same `startConfigWatcher` registration called by production `EdgeWorker.start`;
unrelated startup integrations are not invoked. Real files and chokidar/Node:

- Initial off: authenticated delivery returns disabled, no prompt.
- Write true: watcher applies config; one XML prompt reaches responsible session.
- Atomically replace file with false: delivery returns disabled.
- Write true, then remove key: disabled again; still only one prompt overall.
- Existing stale/duplicate/unauthenticated assertions continue to pass.

Node passes with each change observed after roughly 500 ms. Bun's watcher did not
emit changes on this macOS test host; use Node, matching the deployed CLI runtime.
The watcher is real; GitHub API and model runner remain fixtures.
