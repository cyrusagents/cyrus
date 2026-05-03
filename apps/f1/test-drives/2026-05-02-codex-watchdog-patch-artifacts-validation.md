# Test Drive 2026-05-02: Codex Watchdog Patch Artifacts Validation

**Date**: 2026-05-02
**Goal**: Run the required F1 protocol during BRI-1439 validation and confirm baseline issue-tracker/session pipeline behavior.
**Test Repo**: /tmp/f1-test-drive-20260502-122845

## Verification Results

### Issue-Tracker
- [ ] Issue created
- [ ] Issue ID returned
- [ ] Issue metadata accessible

### EdgeWorker
- [ ] Session started
- [ ] Worktree created (if applicable)
- [ ] Activities tracked
- [ ] Agent processed issue

### Renderer
- [ ] Activity format correct
- [ ] Pagination works
- [ ] Search works

## Session Log

Commands executed:

```bash
node apps/f1/dist/src/cli.js init-test-repo -p /tmp/f1-test-drive-20260502-122845
CYRUS_PORT=3600 CYRUS_REPO_PATH=/tmp/f1-test-drive-20260502-122845 node apps/f1/dist/server.js
CYRUS_PORT=3600 node apps/f1/dist/src/cli.js ping
CYRUS_PORT=3600 node apps/f1/dist/src/cli.js status
```

Key outputs:

- `init-test-repo` succeeded and initialized git repo + seed files.
- F1 server started and reported `RPC: http://localhost:3600/cli/rpc`.
- CLI `ping` failed with `HTTP 404: Not Found` against `/cli/rpc`.
- CLI `status` failed with `HTTP 404: Not Found` against `/cli/rpc`.

Logs:
- `/tmp/bri1439-f1-server.log`
- `/tmp/bri1439-f1-server2.log`

## Final Retrospective

F1 protocol was executed, but this environment currently fails at the RPC transport step (`/cli/rpc` returns 404), so the full issue/session/renderer path could not be completed in this run. This is an environment-level F1 regression unrelated to the Codex watchdog patch content.
