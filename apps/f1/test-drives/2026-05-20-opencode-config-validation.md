# OpenCode Config Validation F1 Test Drive

Date: 2026-05-20
Branch: `opencode-cli-runner-support`
Worktree: `/Users/jappy/.cyrus/worktrees/opencode-config-validation`

## Goal

Validate that Cyrus can run an OpenCode-selected issue end to end after injecting OpenCode MCP and permission configuration through runtime config.

## Environment

- F1 server: `http://localhost:3600`
- F1 repository: `/tmp/f1-test-drive-opencode-config`
- OpenCode CLI: `/opt/homebrew/bin/opencode`, version `1.15.5`

## Commands

```bash
apps/f1/f1 init-test-repo --path /tmp/f1-test-drive-opencode-config

CYRUS_PORT=3600 CYRUS_REPO_PATH=/tmp/f1-test-drive-opencode-config \
  bun run apps/f1/server.ts

CYRUS_PORT=3600 apps/f1/f1 ping
CYRUS_PORT=3600 apps/f1/f1 status

CYRUS_PORT=3600 apps/f1/f1 create-issue \
  --title "OpenCode config validation" \
  --description $'Validate OpenCode MCP and permission config injection.\n\n[agent=opencode]\n\nPlease inspect src/index.ts and respond with a short summary. Do not modify files.' \
  --labels opencode

CYRUS_PORT=3600 apps/f1/f1 start-session --issue-id issue-1
CYRUS_PORT=3600 apps/f1/f1 prompt-session --session-id session-1 --message "test-repo"
CYRUS_PORT=3600 apps/f1/f1 view-session --session-id session-1 --limit 120 --offset 0
CYRUS_PORT=3600 apps/f1/f1 stop-session --session-id session-1
```

## Verification Results

### Issue-Tracker
- [x] Issue created as `DEF-1`
- [x] Issue ID returned as `issue-1`
- [x] Repository selection elicitation posted

### EdgeWorker
- [x] Session started as `session-1`
- [x] Worktree created for `DEF-1`
- [x] OpenCode runner selected from `[agent=opencode]`
- [x] OpenCode completed successfully

### Renderer
- [x] Timeline showed elicitation, prompt, routing thoughts, model selection, action, and response
- [x] Tool activity was visible as a `Read` action
- [x] Final response was posted

## Session Log

Key timeline entries:

```text
elicitation  Which repository should I work in for this issue?
prompt       test-repo
thought      Routing (User selection) - F1 Test Repository
thought      Using model: opencode
action       {"type":"action","action":"Read","parameter":"/private/var/.../src/index.ts"}
response     The file is a barrel export for a rate limiter library...
```

Server logs showed unsupported Cyrus-only permission patterns being logged and skipped instead of silently ignored. OpenCode completed without the SQLite checkpoint failure seen in the runner-selection test drive, which confirms the XDG state isolation path is effective for this run.

## Final Retrospective

PASS: Cyrus routed the issue to OpenCode, injected runtime configuration, preserved timeline visibility, and received a final successful OpenCode response.
