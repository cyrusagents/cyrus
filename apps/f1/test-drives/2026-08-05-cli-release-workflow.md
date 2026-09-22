# Test Drive: Trusted CLI Release Workflow

**Date**: 2026-08-05
**Goal**: Validate the F1 issue, session, worktree, agent, and activity pipeline after adding the trusted CLI release workflow.
**Test Repo**: `/private/tmp/f1-cli-release-workflow.Tmuhqu`
**F1 Port**: `3600`

## Verification Results

### Issue-Tracker

- [x] Issue created
- [x] Issue ID returned
- [x] Issue metadata accessible through the session view

### EdgeWorker

- [x] Session started
- [x] Worktree created after repository selection
- [x] Activities tracked
- [x] Codex agent processed the issue

### Renderer

- [x] Activity format correct
- [x] Pagination works
- [ ] Search works (the F1 CLI does not expose a session-search command)

## Session Log

Created a fresh F1 repository:

```sh
apps/f1/f1 init-test-repo \
  --path /private/tmp/f1-cli-release-workflow.Tmuhqu
```

Started the server and verified health:

```sh
ATMIKO_PORT=3600 \
ATMIKO_DEFAULT_RUNNER=gemini \
ATMIKO_REPO_PATH=/private/tmp/f1-cli-release-workflow.Tmuhqu \
bun run apps/f1/server.ts

ATMIKO_PORT=3600 apps/f1/f1 ping
ATMIKO_PORT=3600 apps/f1/f1 status
```

The server reported `ready` and registered the CLI RPC and event transports.

The initial Gemini scenario reached repository selection, created the issue
worktree, started Gemini, emitted activity, and completed its first tool call.
Gemini then exited with code 53, so that attempt did not satisfy the F1
no-unhandled-error criterion.

The same scenario was rerun through Codex:

```sh
ATMIKO_PORT=3600 apps/f1/f1 create-issue \
  --title "Release workflow validation (Codex)" \
  --description "[agent=codex]
Validate the F1 issue/session/activity pipeline for the trusted CLI release workflow change."

ATMIKO_PORT=3600 apps/f1/f1 start-session --issue-id issue-2
ATMIKO_PORT=3600 apps/f1/f1 prompt-session \
  --session-id session-2 \
  --message "Use the configured test repository for this issue."
```

Codex selected `gpt-5.5`, inspected the repository, and emitted 20 activities,
including `elicitation`, `prompt`, `thought`, and `action` entries. The worktree
was created from local `main`; the expected fetch warning occurred because the
fresh fixture repository has no remote.

Renderer and pagination checks:

```sh
ATMIKO_PORT=3600 apps/f1/f1 view-session --session-id session-2
ATMIKO_PORT=3600 apps/f1/f1 view-session \
  --session-id session-2 \
  --limit 10 \
  --offset 0
```

Both commands rendered timestamped, readable activities. The paginated view
showed 10 of 20 activities and printed the next-page guidance.

Cleanup:

```sh
ATMIKO_PORT=3600 apps/f1/f1 stop-session --session-id session-2
```

The session stopped successfully, and SIGINT shut the F1 server down cleanly
after it saved EdgeWorker state.

## Final Retrospective

The passing Codex run validated the full F1 control path relevant to this
repository-level release change: server readiness, issue creation, repository
selection, worktree creation, runner selection, live agent work, activity
rendering, pagination, session stop, and graceful shutdown. Gemini's code 53
exit is recorded as a harness-specific failed attempt; it did not recur in the
passing Codex run and is unrelated to the release workflow files.
