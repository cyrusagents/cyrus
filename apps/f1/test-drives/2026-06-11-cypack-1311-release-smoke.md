# Test Drive: CYPACK-1311 Release Smoke

**Date**: 2026-06-11
**Goal**: Validate the v0.2.64 release branch can run the F1 issue/session/activity path before publishing.
**Test Repo**: `/private/tmp/f1-cypack-1311-20260611`
**Server Port**: `3601` (`3600` was already in use)

## Verification Results

### Issue-Tracker
- [x] Issue created
- [x] Issue ID returned
- [x] Issue metadata accessible through session view

### EdgeWorker
- [x] Server started
- [x] Session started
- [ ] Worktree created
- [x] Activities tracked
- [x] Agent processed the issue to repository-selection elicitation

### Renderer
- [x] Activity format correct
- [x] Pagination command works
- [ ] Search not exercised

## Session Log

```bash
./f1 init-test-repo --path /private/tmp/f1-cypack-1311-20260611
```

Created a fresh test repository with initial commit on `main`.

```bash
ATMIKO_PORT=3601 ATMIKO_REPO_PATH=/private/tmp/f1-cypack-1311-20260611 bun run apps/f1/server.ts
```

Server started successfully on `http://localhost:3601`. Port `3600` was already occupied.

```bash
ATMIKO_PORT=3601 ./f1 ping
ATMIKO_PORT=3601 ./f1 status
```

Health check passed. Server status was `ready`.

```bash
ATMIKO_PORT=3601 ./f1 create-issue \
  --title "CYPACK-1311 release smoke" \
  --description "Validate the release branch can create issues, start a session, and render activities during the v0.2.64 release process. Keep changes minimal; report status only."
```

Created issue `issue-1` / `DEF-1`.

```bash
ATMIKO_PORT=3601 ./f1 start-session --issue-id issue-1
```

Started `session-1`.

```bash
ATMIKO_PORT=3601 ./f1 view-session --session-id session-1 --limit 10 --offset 0
```

Observed one activity:

| Type | Message |
| --- | --- |
| `elicitation` | `Which repository should I work in for this issue?` |

```bash
ATMIKO_PORT=3601 ./f1 stop-session --session-id session-1
```

Session stopped successfully. Server then stopped gracefully via SIGINT.

## Final Retrospective

The F1 smoke path passed for server startup, issue creation, session creation, and activity rendering. The session did not create a worktree because routing intentionally stopped at repository-selection elicitation in this synthetic setup; that was sufficient for this release validation because CYPACK-1311 only changes release metadata and dependency resolution, not runner behavior.
