# Test Drive: CYPACK-1334 Security Dependency Smoke

**Date**: 2026-06-17
**Goal**: Verify the F1 CLI server and issue-tracker RPC path still work after security dependency patches.
**Test Repo**: `/private/tmp/f1-cypack-1334-security`

## Verification Results

### Issue-Tracker
- [x] Issue created
- [x] Issue ID returned
- [x] Issue metadata accessible

### EdgeWorker
- [x] Server started
- [x] CLI RPC server registered
- [x] Status endpoint reported ready
- [ ] Agent session not started because this change only patches dependencies and does not alter runner/session behavior

### Renderer
- [x] CLI output remained readable
- [ ] Activity pagination not exercised because no agent session was started

## Session Log

```bash
cd apps/f1 && ./f1 init-test-repo --path /private/tmp/f1-cypack-1334-security
```

Result: fresh test repository created with an initial `main` commit.

```bash
CYRUS_PORT=3600 CYRUS_REPO_PATH=/private/tmp/f1-cypack-1334-security bun run apps/f1/server.ts
```

Result: failed because port `3600` was already in use.

```bash
CYRUS_PORT=3601 CYRUS_REPO_PATH=/private/tmp/f1-cypack-1334-security bun run apps/f1/server.ts
```

Result: server started successfully on `http://localhost:3601`.

```bash
CYRUS_PORT=3601 ./apps/f1/f1 ping
CYRUS_PORT=3601 ./apps/f1/f1 status
CYRUS_PORT=3601 ./apps/f1/f1 create-issue --title "CYPACK-1334 dependency smoke" --description "Verify F1 issue-tracker RPC still works after security dependency patches."
```

Result: ping succeeded, status returned `ready`, and issue `DEF-1` was created.

Server shutdown via `SIGINT` saved EdgeWorker state and stopped cleanly.

## Final Retrospective

The dependency updates did not break F1 server startup, CLI RPC health/status, or issue creation. A full agent-session drive was intentionally skipped because CYPACK-1334 does not change runner selection, session lifecycle, worktree behavior, or activity rendering.
