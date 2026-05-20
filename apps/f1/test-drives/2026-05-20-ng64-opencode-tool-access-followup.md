# Test Drive: NG-64 OpenCode tool access follow-up

**Date**: 2026-05-20
**Goal**: Re-run an OpenCode-selected F1 issue after the live NG-69 tool exposure blocker and verify file activity plus final response rendering without relying on provider-local setup assumptions.
**Test Repo**: `/tmp/f1-ng64-opencode-tool-access-20260520`

## Verification Results

### Issue-Tracker
- [x] Issue created
- [x] Issue ID returned
- [x] Issue metadata accessible

### EdgeWorker
- [x] Session started
- [x] Worktree created
- [x] OpenCode runner selected via `[agent=opencode]`
- [x] Activities tracked
- [x] Agent processed issue

### Renderer
- [x] Activity format correct
- [x] Search works

## Session Log

```bash
apps/f1/f1 init-test-repo --path /tmp/f1-ng64-opencode-tool-access-20260520

CYRUS_PORT=3625 CYRUS_REPO_PATH=/tmp/f1-ng64-opencode-tool-access-20260520 \
  bun run apps/f1/server.ts

CYRUS_PORT=3625 apps/f1/f1 ping
CYRUS_PORT=3625 apps/f1/f1 status

CYRUS_PORT=3625 apps/f1/f1 create-issue \
  --title "NG-64 OpenCode tool access smoke" \
  --description $'Read README.md and reply exactly: F1_OPENCODE_TOOL_ACCESS_OK\n\n[repo=f1-test-repo]\n[agent=opencode]'

CYRUS_PORT=3625 apps/f1/f1 start-session --issue-id issue-1
CYRUS_PORT=3625 apps/f1/f1 view-session --session-id session-1 --limit 50 --offset 0
CYRUS_PORT=3625 apps/f1/f1 view-session --session-id session-1 --search README.md
CYRUS_PORT=3625 apps/f1/f1 view-session --session-id session-1 --search F1_OPENCODE_TOOL_ACCESS_OK
CYRUS_PORT=3625 apps/f1/f1 stop-session --session-id session-1
```

Key outputs:

- Server started on `http://localhost:3625` with Cyrus home `/var/folders/_r/fld8l71j7ts635hlb5vtgnb80000gn/T/cyrus-f1-1779282864490`.
- `RepositoryRouter` selected `F1 Test Repository` via `[repo=f1-test-repo]`.
- Activity timeline included `Using model: opencode`.
- Activity timeline included a `Read` action for `README.md`.
- Final response activity was `F1_OPENCODE_TOOL_ACCESS_OK`.
- Session stopped successfully and the F1 server stopped gracefully.

## Final Retrospective

Pass. The F1 run confirms the OpenCode-selected issue path still renders file activity and final responses correctly after the tool-default fix.

Important limitation: the F1 server intentionally configures full test defaults via `getAllTools()`, so this run does not directly exercise the normal CLI startup path where `ALLOWED_TOOLS` is unset. That specific live regression is covered by `EdgeWorker.multi-repo-tools.test.ts`, which now proves an empty global default tool list falls back to safe built-in tools plus workspace MCP tools instead of reducing sessions to MCP-only access.
