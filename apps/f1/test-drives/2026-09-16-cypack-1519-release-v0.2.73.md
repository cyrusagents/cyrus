# Test Drive: CYPACK-1519 Release v0.2.73

**Date**: 2026-09-16
**Goal**: Prove the local F1 issue, session, worktree, and activity-rendering control path before a potential v0.2.73 publication. This report does not claim full end-to-end runner command execution.
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

## Runner Command-Execution Gate

The Codex runner created and received the configured F1 worktree, but every
read-only local command failed before execution. Its recorded final response
preserves the exact error:

```text
sandbox-exec: sandbox_apply: Operation not permitted
```

The failed reads included `pwd`, `ls`, `git status`, `git remote -v`, and a
skill-file read. No files were edited.

An independent F1 attempt used the supported Claude runner, with no sandbox
flags or permission changes, in a fresh repository at
`/private/tmp/f1-release-v0.2.73-claude-RrTrKE/repo` on port `3602`. It
created `issue-1` / `DEF-1`, selected the repository, created
`/tmp/cyrus-f1-1789541621742/worktrees/DEF-1`, and asked the runner to execute
only `pwd && git status --short`. The runner failed before executing that
command with the exact recorded error:

```text
Failed to authenticate. API Error: 401 OAuth access token has expired.
```

Therefore successful command execution in a configured F1 repository remains
an open validation gate. It requires an existing supported runner with a
working normal execution environment; no denied sandbox was bypassed and no
permissions were expanded.

## Observations

1. The lifecycle/control path still validated issue creation, repository
   selection, worktree setup, runner selection, timeline activity rendering,
   response delivery, pagination, explicit session stop, and graceful shutdown.
2. The synthetic repositories have no `origin`, so their attempted fetches warn
   and F1 correctly proceeds from their local `main` branch.
3. `f1 ping` prints `Status: undefined` despite a successful request; this is
   the known CLI/RPC response-field mismatch.

## Final Retrospective

The F1 release drive proves the lifecycle and control path for local F1 server,
issue creation, session/worktree lifecycle, activity rendering, pagination,
final response, explicit stop, and graceful shutdown. It is not full
end-to-end release validation because neither configured runner completed an
actual command in the F1 repository. The exact remaining gate is successful
read-only command execution by a supported runner in its normal configured F1
environment.

The current candidate covers only CYPACK-1520, CYPACK-1518, and CYPACK-1521.
It excludes #1487 / CYPACK-1522 and consequently does not satisfy the
CYHOST-913 credential-removal release dependency. If #1487 is separately
approved and merged before the release scope is approved, this preparation
must be rebased to that exact main head and repeat the affected validation,
F1 evidence, source inventory, and final-head checks.
