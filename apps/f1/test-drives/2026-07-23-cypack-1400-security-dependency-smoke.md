# Test Drive: CYPACK-1400 Security Dependency Smoke

**Date**: 2026-07-23
**Goal**: Verify F1 server startup, RPC health, status, and issue creation after security dependency patches.
**Test Repo**: `/private/tmp/f1-cypack-1400-security-20260723`

## Verification Results

### Issue-Tracker
- [x] Issue created
- [x] Issue ID returned
- [x] Issue metadata accessible in create response

### EdgeWorker
- [x] Server started
- [x] RPC endpoint available
- [x] Status endpoint reported ready
- [ ] Full agent session not run; CYPACK-1400 only changes dependency resolution and does not alter runner/session lifecycle behavior.

### Renderer
- [ ] Activity rendering not run; no agent session was started for this dependency-only smoke.

## Session Log

```bash
apps/f1/f1 init-test-repo --path /private/tmp/f1-cypack-1400-security-20260723
```

Result: test repository created successfully with initial git commit.

```bash
CYRUS_PORT=3614 CYRUS_REPO_PATH=/private/tmp/f1-cypack-1400-security-20260723 bun run apps/f1/server.ts
```

Result: server started on `http://localhost:3614`; CLI RPC, event transports, config updater, MCP endpoint, status, and version routes registered successfully.

```bash
CYRUS_PORT=3614 apps/f1/f1 ping
CYRUS_PORT=3614 apps/f1/f1 status
CYRUS_PORT=3614 apps/f1/f1 create-issue --title "CYPACK-1400 dependency smoke" --description "Verify F1 server health, status, and issue creation after security dependency patches."
```

Result: ping succeeded, status returned `ready`, and issue `DEF-1` was created.

Server was stopped with SIGINT and shut down gracefully.

## Final Retrospective

The dependency updates did not break F1 server startup, CLI RPC health/status, or issue creation. A full agent-session drive was intentionally skipped because CYPACK-1400 does not change runner selection, session lifecycle, worktree behavior, or activity rendering.
