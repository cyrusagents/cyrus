# NG-62 OpenCode Runner Selection F1 Test Drive

Date: 2026-05-20
Branch: `opencode-cli-runner-support`
Worktree: `/Users/jappy/.cyrus/worktrees/NG-62`

## Goal

Validate that Cyrus can route an issue to the OpenCode runner when the issue uses the `opencode` label and `[agent=opencode]` selector.

## Environment

- F1 server: `http://localhost:3600`
- F1 repository: `/tmp/f1-test-drive-ng62-opencode`
- OpenCode CLI: `/opt/homebrew/bin/opencode`, version `1.15.5`

## Commands

```bash
apps/f1/f1 init-test-repo --path /tmp/f1-test-drive-ng62-opencode

CYRUS_PORT=3600 CYRUS_REPO_PATH=/tmp/f1-test-drive-ng62-opencode \
  bun run apps/f1/server.ts

CYRUS_PORT=3600 apps/f1/f1 ping
CYRUS_PORT=3600 apps/f1/f1 status

CYRUS_PORT=3600 apps/f1/f1 create-issue \
  --title "NG-62 OpenCode runner selection validation" \
  --description $'Validate OpenCode runner selection via label and selector.\n\n[agent=opencode]\n\nPlease inspect src/index.ts and respond with a short summary. Do not modify files.' \
  --labels opencode

CYRUS_PORT=3600 apps/f1/f1 start-session --issue-id issue-1
CYRUS_PORT=3600 apps/f1/f1 prompt-session --session-id session-1 --message "test-repo"
CYRUS_PORT=3600 apps/f1/f1 view-session --session-id session-1 --limit 50 --offset 0
CYRUS_PORT=3600 apps/f1/f1 stop-session --session-id session-1
```

## Observed Result

The session initially posted the expected repository selection elicitation, then accepted the repository prompt and started the agent run.

The activity timeline showed:

```text
elicitation  Which repository should I work in for this issue?
prompt       test-repo
thought      Routing (User selection) - F1 Test Repository
thought      Using model: opencode
error        OpenCode exited with code 1: Error: Unexpected error...
```

Server logs confirmed the OpenCode runner was selected and invoked:

```text
Using model: opencode
OpenCode exited with code 1: Error: Unexpected error, check log file at /Users/jappy/.local/share/opencode/log/2026-05-20T075926.log for more details

Failed to run the query 'PRAGMA wal_checkpoint(PASSIVE)'
```

The referenced OpenCode log file was not present under `/Users/jappy/.local/share/opencode/log` after the failure.

## Assessment

- PASS: `[agent=opencode]` plus the `opencode` label routed to the OpenCode runner.
- PASS: The session timeline emitted `Using model: opencode`.
- BLOCKED: End-to-end OpenCode execution could not complete because the local OpenCode CLI failed internally while checkpointing SQLite state.

The blocker appears to be local OpenCode runtime state rather than Cyrus runner selection, because Cyrus reached the OpenCode runner and surfaced the OpenCode process failure cleanly.
