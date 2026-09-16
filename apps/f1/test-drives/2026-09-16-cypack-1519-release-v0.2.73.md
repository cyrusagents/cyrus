# Test Drive: CYPACK-1519 Release v0.2.73

**Date**: 2026-09-16
**Goal**: Validate the local F1 issue, Codex session, and activity-rendering flow before a potential v0.2.73 publication.
**Test Repo**: `/private/tmp/f1-release-v0.2.73-W92TXb/repo-codex`
**F1 Port**: `3601`
**Reference Issue**: CYPACK-1519 (`run a release`)
**Candidate Source**: `e9e1e53d629b023545ebfd821bcd16c67f44f217` before release metadata preparation

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

Built the candidate and F1 application:

```bash
pnpm build
pnpm --filter cyrus-f1 build
```

Result: all workspace builds succeeded using the TypeScript native compiler.

Created a fresh test repository and started F1 with an isolated, logged-in
Codex home:

```bash
apps/f1/f1 init-test-repo --path /private/tmp/f1-release-v0.2.73-W92TXb/repo-codex
CODEX_HOME=/private/tmp/f1-release-v0.2.73-W92TXb/codex-home \
CYRUS_PORT=3601 \
CYRUS_DEFAULT_RUNNER=codex \
CYRUS_REPO_PATH=/private/tmp/f1-release-v0.2.73-W92TXb/repo-codex \
bun run apps/f1/server.ts
CYRUS_PORT=3601 apps/f1/f1 ping
CYRUS_PORT=3601 apps/f1/f1 status
```

Result: the server started cleanly and `status` returned `ready`. `ping`
succeeded but printed `Status: undefined`, the established F1 CLI/RPC
field-name mismatch.

Created an inspection-only issue, started a session, and resolved repository
selection:

```bash
CYRUS_PORT=3601 apps/f1/f1 create-issue \
  --title "Release v0.2.73 F1 validation" \
  --description "Inspect the configured F1 test repository and report its current implementation status. Do not edit files."
CYRUS_PORT=3601 apps/f1/f1 start-session --issue-id issue-1
CYRUS_PORT=3601 apps/f1/f1 prompt-session \
  --session-id session-1 \
  --message "Use the configured F1 Test Repository for this issue."
```

Result: F1 created `issue-1` / `DEF-1`, selected the configured repository,
created `/tmp/cyrus-f1-1789538282850/worktrees/DEF-1`, and ran Codex with
`gpt-5.5`. The session produced a final response and rendered 25 visible
timeline activities before the explicit stop command.

Verified renderer output and pagination, then stopped the session and server:

```bash
CYRUS_PORT=3601 apps/f1/f1 view-session --session-id session-1 --limit 10 --offset 0
CYRUS_PORT=3601 apps/f1/f1 view-session --session-id session-1 --limit 10 --offset 10
CYRUS_PORT=3601 apps/f1/f1 stop-session --session-id session-1
```

Result: both pagination windows returned the expected ten activities, the
session stop succeeded, and F1 shut down gracefully after saving EdgeWorker
state.

## Non-blocking Observations

1. The Codex runner's command sandbox failed before it could inspect the
   generated test repository. Its final response reported that limitation
   accurately. It did not prevent the F1 control path from validating issue
   creation, routing, worktree setup, runner selection, timeline activity
   rendering, response delivery, pagination, session stop, or graceful
   shutdown.
2. The synthetic repository has no `origin`, so its attempted fetch warns and
   F1 correctly proceeds from its local `main` branch.
3. `f1 ping` prints `Status: undefined` despite a successful request; this is
   the known CLI/RPC response-field mismatch.

## Final Retrospective

The F1 release drive passed for the local F1 server, issue creation, session
and worktree lifecycle, activity rendering, pagination, final response,
explicit stop, and graceful shutdown. The runner sandbox limitation is
environment-specific and did not block the end-to-end release validation.
**v0.2.73 is ready for the remaining release checks, but is not authorized for
publication.**
