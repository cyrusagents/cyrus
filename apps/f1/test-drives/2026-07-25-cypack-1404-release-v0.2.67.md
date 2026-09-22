# Test Drive: CYPACK-1404 Release v0.2.67 Smoke

**Date**: 2026-07-25
**Goal**: Validate the local F1 issue/session/activity flow before publishing v0.2.67.
**Test Repo**: `/private/tmp/f1-test-drive-cypack-1404-0.2.67`
**F1 Port**: `3600`

## Verification Results

### Issue-Tracker
- [x] Issue created
- [x] Issue ID returned
- [x] Issue metadata accessible through session view

### EdgeWorker
- [x] Session started
- [x] Worktree created after repository-selection response
- [x] Activities tracked
- [x] Agent processed issue with Gemini runner

### Renderer
- [x] Activity format correct
- [x] Pagination works
- [ ] Search works (`view-session` pagination was validated; no search command exists in the F1 CLI)

## Session Log

```bash
apps/f1/f1 init-test-repo --path /private/tmp/f1-test-drive-cypack-1404-0.2.67
```

Result: created a fresh git repository with initial commit on `main`.

```bash
ATMIKO_PORT=3600 ATMIKO_REPO_PATH=/private/tmp/f1-test-drive-cypack-1404-0.2.67 bun run apps/f1/server.ts
ATMIKO_PORT=3600 apps/f1/f1 create-issue --title "Release smoke validation" --description "Validate that Atmiko can create an issue, start a session, and render activities for the v0.2.67 release."
ATMIKO_PORT=3600 apps/f1/f1 start-session --issue-id issue-1
```

Result: the default Claude-backed run started and rendered repository selection, routing, worktree creation, model notification, and an error activity. Agent execution did not proceed because the local organization has disabled Claude subscription access.

```bash
ATMIKO_PORT=3600 ATMIKO_DEFAULT_RUNNER=codex ATMIKO_REPO_PATH=/private/tmp/f1-test-drive-cypack-1404-0.2.67 bun run apps/f1/server.ts
ATMIKO_PORT=3600 apps/f1/f1 create-issue --title "Release smoke validation (Codex)" --description "[agent=codex]
Validate that Atmiko can create an issue, start a Codex session, and render activities for the v0.2.67 release."
ATMIKO_PORT=3600 apps/f1/f1 start-session --issue-id issue-1
ATMIKO_PORT=3600 apps/f1/f1 prompt-session --session-id session-1 --message "Use the configured test repository for this issue."
```

Result: the Codex-backed run started and rendered repository selection, routing, worktree creation, model notification, and an error activity. Agent execution did not proceed because the Codex app-server exited during startup.

```bash
HOME=/private/tmp/f1-gemini-home-cypack-1404 \
ATMIKO_PORT=3600 \
ATMIKO_DEFAULT_RUNNER=gemini \
ATMIKO_REPO_PATH=/private/tmp/f1-test-drive-cypack-1404-0.2.67 \
bun run apps/f1/server.ts
```

Result: server started on `http://localhost:3600`; ping returned healthy; status returned `ready`. The temp `HOME` was required because the global Gemini CLI writes chat recordings under `$HOME/.gemini`, and the default home directory was not writable in the sandbox.

```bash
ATMIKO_PORT=3600 apps/f1/f1 create-issue \
  --title "Release smoke validation (Gemini temp HOME)" \
  --description "[agent=gemini]
Validate that Atmiko can create an issue, start a Gemini session, and render activities for the v0.2.67 release."

ATMIKO_PORT=3600 apps/f1/f1 start-session --issue-id issue-1
ATMIKO_PORT=3600 apps/f1/f1 view-session --session-id session-1
ATMIKO_PORT=3600 apps/f1/f1 prompt-session --session-id session-1 --message "Use the configured test repository for this issue."
```

Result: created issue `issue-1` / `DEF-1`, started `session-1`, and rendered repository-selection elicitation.

After repository selection, EdgeWorker reused the F1 test worktree, selected the Gemini runner from `[agent=gemini]`, emitted `Using model: gemini-2.5-pro`, and streamed coherent `thought` and `action` activities. The full view showed 17 activities at the time checked, including `elicitation`, `prompt`, `thought`, and `action` rows.

```bash
ATMIKO_PORT=3600 apps/f1/f1 view-session --session-id session-1 --limit 10 --offset 0
```

Result: pagination rendered 10 of 17 activities and displayed the follow-up pagination guidance.

```bash
ATMIKO_PORT=3600 apps/f1/f1 stop-session --session-id session-1
```

Result: session stopped successfully.

## Final Retrospective

F1 validated the local server, issue tracker, repository-selection recovery, worktree creation, Gemini runner startup, activity rendering, pagination, and session stop path for v0.2.67. Claude and Codex attempts reached routing/rendering but were blocked by local runner/runtime configuration, so the passing execution run used Gemini with a writable temp `HOME`.
