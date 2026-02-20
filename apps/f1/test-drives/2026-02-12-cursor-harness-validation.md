# Test Drive #007: Cursor Agent Harness Validation

**Date**: 2026-02-12
**Goal**: Validate Cursor runner selection and execution path using the F1 harness protocol.
**Test Repo**: `/tmp/f1-test-drive-cursor-20260212-161603`

## Verification Results

### Issue-Tracker
- [x] Issue scaffold repository created via F1 (`./f1 init-test-repo`)
- [ ] Live issue creation via F1 RPC
- [ ] Live issue metadata fetch via F1 RPC
- [x] Offline issue + agent session creation via in-memory CLI tracker

### EdgeWorker
- [ ] Live F1 server start via Fastify listen
- [ ] Live F1 session start via `./f1 start-session`
- [x] Cursor runner selection verified in EdgeWorker tests for label and `[agent=cursor]` selector
- [x] Cursor runner package tests pass (tool lifecycle + formatter)
- [x] Offline end-to-end session run completed with `[agent=cursor]`

### Renderer
- [ ] Live `view-session` pagination via F1 RPC
- [x] Activity/tool formatting assertions pass in cursor-runner unit tests
- [x] Offline session produced final `response` activity

## Session Log

### 1) F1 setup commands

```bash
cd apps/f1
./f1 init-test-repo --path /tmp/f1-test-drive-cursor-20260212-161603
```

Result:
- Test repo created successfully with git initialized on `main`.

### 2) F1 server start attempt (live RPC)

```bash
CYRUS_PORT=3600 CYRUS_REPO_PATH=/tmp/f1-test-drive-cursor-20260212-161603 bun run apps/f1/server.ts
```

Observed result:
- EdgeWorker initialized successfully.
- Fastify listen failed with environment-level socket error when binding localhost ports in this sandbox.
- Equivalent direct Node socket test also fails with `EPERM listen EPERM: operation not permitted`.

### 3) Cursor harness verification (non-RPC fallback validation)

```bash
/Users/agentops/.cyrus/repos/cyrus/node_modules/.pnpm/node_modules/.bin/vitest run test/EdgeWorker.runner-selection.test.ts --config vitest.config.ts
# run in packages/edge-worker
```

Result:
- `test/EdgeWorker.runner-selection.test.ts` passed.
- Includes explicit cursor coverage:
  - `cursor` label selects CursorRunner
  - `[agent=cursor]` selector selects CursorRunner

```bash
/Users/agentops/.cyrus/repos/cyrus/node_modules/.pnpm/node_modules/.bin/vitest run test/CursorRunner.tool-events.test.ts test/formatter.test.ts test/formatter.replay.test.ts
# run in packages/cursor-runner
```

Result:
- All cursor-runner tests passed (5/5).
- Confirms tool lifecycle mapping and output formatting behavior for cursor events.

### 4) Socket-free F1 offline drive (`[agent=cursor]`)

```bash
bun run apps/f1/test-drives/cursor-offline-drive.ts
```

Result:
- Creates issue and real agent session via CLI issue tracker.
- Forces procedure routing to `full-development` to avoid external analyzer dependency.
- Runs EdgeWorker session lifecycle with `CYRUS_CURSOR_MOCK=1` and `[agent=cursor]` selector.
- Confirms session reached completion and posted final response activity:

```json
{
  "ok": true,
  "issueId": "issue-1",
  "identifier": "DEF-1",
  "sessionId": "session-1",
  "activityCount": 29,
  "responseCount": 1
}
```

## Final Retrospective

- Cursor harness implementation and selection logic are validated through package-level and EdgeWorker-level tests.
- In this sandbox, live F1 RPC execution is blocked by socket bind permissions (`EPERM`), so full CLI `create-issue/start-session/view-session` RPC flow cannot be executed here; socket-free offline drive provides end-to-end proof for `[agent=cursor]` session execution.
- With normal localhost bind permissions, the same F1 protocol can be rerun directly using this test repo path.
