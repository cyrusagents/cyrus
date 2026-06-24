# Test Drive: CYPACK-1342 Release v0.2.66 Smoke

**Date**: 2026-06-19
**Goal**: Validate the local F1 issue/session/activity flow before publishing v0.2.66.
**Test Repo**: `/tmp/f1-test-drive-cypack-1342-0.2.66`
**F1 Port**: `3612` (`3600` was already in use)

## Verification Results

### Issue-Tracker
- [x] Issue created
- [x] Issue ID returned
- [x] Issue metadata accessible through session view

### EdgeWorker
- [x] Session started
- [x] Worktree created after repository-selection response
- [x] Activities tracked
- [x] Agent began processing the issue

### Renderer
- [x] Activity format correct
- [x] Pagination works
- [ ] Search works (`view-session` pagination was validated; no search command exists in the F1 CLI)

## Session Log

```bash
apps/f1/f1 init-test-repo --path /tmp/f1-test-drive-cypack-1342-0.2.66
```

Result: created a fresh git repository with initial commit on `main`.

```bash
CYRUS_PORT=3600 CYRUS_REPO_PATH=/tmp/f1-test-drive-cypack-1342-0.2.66 bun run apps/f1/server.ts
```

Result: failed because port `3600` was already in use.

```bash
CYRUS_PORT=3612 CYRUS_REPO_PATH=/tmp/f1-test-drive-cypack-1342-0.2.66 bun run apps/f1/server.ts
CYRUS_PORT=3612 apps/f1/f1 ping
CYRUS_PORT=3612 apps/f1/f1 status
```

Result: server started on `http://localhost:3612`; ping returned healthy; status returned `ready`.

```bash
CYRUS_PORT=3612 apps/f1/f1 create-issue \
  --title "Release smoke validation" \
  --description "Validate that Cyrus can create an issue, start a session, and render activities for the v0.2.66 release."
```

Result: created issue `issue-1` / `DEF-1`.

```bash
CYRUS_PORT=3612 apps/f1/f1 start-session --issue-id issue-1
```

Result: started `session-1`.

The first activity was repository-selection elicitation:

```text
Which repository should I work in for this issue?
```

Answered with:

```bash
CYRUS_PORT=3612 apps/f1/f1 prompt-session \
  --session-id session-1 \
  --message "Use the configured test repository for this issue."
```

Result: EdgeWorker selected the F1 test repository, created the worktree, assigned a Claude session id, emitted model notification, thought activities, and tool action activities.

```bash
CYRUS_PORT=3612 apps/f1/f1 view-session --session-id session-1
CYRUS_PORT=3612 apps/f1/f1 view-session --session-id session-1 --limit 10 --offset 0
```

Result: both commands rendered session details and activities. The full view showed 10 activities at the time checked, including `elicitation`, `prompt`, `thought`, and `action` rows.

```bash
CYRUS_PORT=3612 apps/f1/f1 stop-session --session-id session-1
```

Result: session stopped successfully.

## Final Retrospective

F1 validated the local server, issue tracker, session start, repository-selection recovery, worktree creation, activity rendering, pagination, and session stop path. The only setup issue was a local port conflict on `3600`; rerunning on `3612` passed.
