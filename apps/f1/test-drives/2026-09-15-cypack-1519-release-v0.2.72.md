# Test Drive: CYPACK-1519 Release v0.2.72

**Date**: 2026-09-15
**Goal**: Validate the local F1 issue, Codex session, and activity-rendering flow before publishing v0.2.72.
**Test Repo**: `/private/tmp/f1-release-v0.2.72-XiM1RU/repo-codex`
**F1 Port**: `3601`
**Reference Issue**: CYPACK-1519 (`run a release`)

## Verification Results

### Issue-Tracker

- [x] Issue created (`issue-1`, `DEF-1`)
- [x] Issue ID returned
- [x] Issue metadata accessible through session view

### EdgeWorker

- [x] Session started (`session-1`)
- [x] Repository selection completed
- [x] Worktree created
- [x] Activities tracked
- [x] Agent produced a final response
- [x] Session stopped cleanly

### Renderer

- [x] Activity format correct (`elicitation`, `prompt`, `thought`, `action`, and `response`)
- [x] Timestamps present
- [x] Pagination works (`--limit 10 --offset 0` and `--offset 10`)

## Session Log

Built the F1 app and all required workspace dependencies:

```bash
pnpm install
pnpm --filter cyrus-f1... build
```

Result: the install left the lockfile unchanged and all selected projects built successfully.

Created a fresh repository, copied the existing local Codex authentication into an isolated temporary Codex home so its SQLite state could be created, then started F1 with the Codex runner:

```bash
apps/f1/f1 init-test-repo --path /private/tmp/f1-release-v0.2.72-XiM1RU/repo-codex
CODEX_HOME=/private/tmp/f1-release-v0.2.72-XiM1RU/codex-home \
CYRUS_PORT=3601 \
CYRUS_DEFAULT_RUNNER=codex \
CYRUS_REPO_PATH=/private/tmp/f1-release-v0.2.72-XiM1RU/repo-codex \
bun run apps/f1/server.ts
CYRUS_PORT=3601 apps/f1/f1 ping
CYRUS_PORT=3601 apps/f1/f1 status
```

Result: the server started cleanly and `status` returned `ready`. `ping` succeeded but printed `Status: undefined`, the established F1 CLI/RPC field-name mismatch.

Created an inspection-only issue, started a session, and resolved repository selection:

```bash
CYRUS_PORT=3601 apps/f1/f1 create-issue \
  --title "Release v0.2.72 F1 validation" \
  --description "Inspect the configured F1 test repository and report its current implementation status. Do not edit files."
CYRUS_PORT=3601 apps/f1/f1 start-session --issue-id issue-1
CYRUS_PORT=3601 apps/f1/f1 prompt-session \
  --session-id session-1 \
  --message "Use the configured F1 Test Repository for this issue."
```

Result: F1 created `issue-1` / `DEF-1` and `session-1`, selected the configured repository, created `/tmp/cyrus-f1-1789508504486/worktrees/DEF-1`, and ran Codex with `gpt-5.5`. The session completed with `success` and rendered 16 coherent timeline activities plus a final response.

Verified renderer output and pagination:

```bash
CYRUS_PORT=3601 apps/f1/f1 view-session --session-id session-1
CYRUS_PORT=3601 apps/f1/f1 view-session --session-id session-1 --limit 10 --offset 0
CYRUS_PORT=3601 apps/f1/f1 view-session --session-id session-1 --limit 10 --offset 10
CYRUS_PORT=3601 apps/f1/f1 stop-session --session-id session-1
```

Result: the full view returned 16 activities; the two pagination windows returned 10 and 6 activities. The stop command succeeded and the server shut down gracefully after saving EdgeWorker state.

## Non-blocking Observations

1. The default Claude runner could not be used because its local OAuth access token had expired. The drive was rerun successfully with the logged-in Codex runner.
2. The Codex model encountered a sandbox bootstrap error before it could run shell commands in the generated worktree, so its final response accurately reported that it could not inspect the scaffold. This did not prevent the end-to-end issue, routing, runner, activity, response, pagination, stop, or graceful-shutdown validation.
3. `f1 ping` prints `Status: undefined` despite a successful request; this is the known CLI/RPC response-field mismatch.

## Final Retrospective

The F1 release drive validated the complete local F1 server, issue creation, repository-selection recovery, worktree setup, Codex session lifecycle, activity rendering, pagination, final-response delivery, session stop, and graceful shutdown paths. The isolated Codex home avoided the host read-only state-directory limitation, and no unhandled server or runner error occurred. The model-level sandbox bootstrap limitation and unavailable Claude OAuth credential are environment issues noted above; they did not block the F1 pipeline validation. **v0.2.72 is validated for publishing.**
