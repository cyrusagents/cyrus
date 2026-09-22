# Test Drive: CYPACK-1286 — Codex MCP Config Wiring

**Date**: 2026-06-04
**Goal**: Validate the F1 issue/session path for a Codex-selected session and confirm MCP config reaches the Codex runner.
**Test Repo**: `/tmp/f1-test-drive-cypack-1286-codex-mcp`

## Verification Results

### Issue-Tracker
- [x] Issue created
- [x] Issue ID returned
- [x] Issue metadata accessible

### EdgeWorker
- [x] Session started
- [x] Worktree created
- [x] Description-tag routing selected the F1 test repository
- [x] Codex runner selected via `[agent=codex]`
- [x] Codex runner logged MCP config handoff
- [ ] Agent completed prompt processing

### Renderer
- [x] Activities were created
- [x] Activity payloads were readable
- [x] Error activity captured the local Codex runtime failure

## Session Log

```bash
pnpm --filter atmiko-f1 build
apps/f1/f1 init-test-repo --path /tmp/f1-test-drive-cypack-1286-codex-mcp
ATMIKO_PORT=3600 ATMIKO_REPO_PATH=/tmp/f1-test-drive-cypack-1286-codex-mcp node apps/f1/dist/server.js
ATMIKO_PORT=3600 apps/f1/f1 ping
ATMIKO_PORT=3600 apps/f1/f1 status
ATMIKO_PORT=3600 apps/f1/f1 create-issue \
  --title "CYPACK-1286 Codex MCP smoke" \
  --description "[agent=codex] [repo=f1-test/primary-repo]\n\nReply with exactly: codex f1 smoke ok"
ATMIKO_PORT=3600 apps/f1/f1 start-session --issue-id issue-1
ATMIKO_PORT=3600 apps/f1/f1 view-session --session-id session-1 --limit 20
ATMIKO_PORT=3600 apps/f1/f1 stop-session --session-id session-1
```

Key server log evidence:

```text
Repositories selected: [F1 Test Repository] (description-tag routing)
Label-based runner selection for new session: codex (session session-1)
[CodexRunner] Configured 1 MCP server(s) for codex config (docs: https://platform.openai.com/docs/docs-mcp)
```

The runner failed after startup because local Codex could not access its session directory:

```text
Fatal error: Codex cannot access session files at /Users/agentops/.codex/sessions (permission denied).
```

## Final Retrospective

The F1 drive validates the Atmiko side of the Codex path: issue creation, repository routing, worktree creation, Codex runner selection, activity rendering, and Codex MCP config handoff. Full prompt processing was blocked by local filesystem permissions on the host Codex session store, not by Atmiko runner config assembly.
