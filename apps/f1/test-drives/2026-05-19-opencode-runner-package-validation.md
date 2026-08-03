# Test Drive: OpenCode Runner Package Validation

**Date**: 2026-05-19
**Goal**: Validate the surrounding F1 issue/session/activity pipeline for the new `cyrus-opencode-runner` package work.
**Test Repo**: `/tmp/f1-test-drive-opencode-runner-20260519174857`

## Verification Results

### Issue-Tracker
- [x] Issue created
- [x] Issue ID returned
- [x] Issue metadata accessible through F1 session view

### EdgeWorker
- [x] Server started
- [x] Repository selector routing verified with `[repo=f1-test-repo]`
- [x] Worktree created for `DEF-1`
- [x] Activities tracked
- [ ] OpenCode runner execution verified end-to-end

OpenCode execution was not directly testable in F1 for this package-only validation because this change only adds `packages/opencode-runner`; runner selection/config wiring is covered by the runner-selection validation.

### Renderer
- [x] Activity format rendered in `view-session`
- [x] Pagination command accepted with `--limit 20 --offset 0`
- [x] Stop response rendered

## Session Log

```bash
apps/f1/f1 init-test-repo --path /tmp/f1-test-drive-opencode-runner-20260519174857
CYRUS_PORT=3600 CYRUS_REPO_PATH=/tmp/f1-test-drive-opencode-runner-20260519174857 bun run apps/f1/server.ts
CYRUS_PORT=3600 apps/f1/f1 ping
CYRUS_PORT=3600 apps/f1/f1 status
CYRUS_PORT=3600 apps/f1/f1 create-issue --title "OpenCode runner package validation with repo" --description $'Validate F1 session plumbing for OpenCode runner package work.\n\n[repo=f1-test-repo]\n\nKeep this minimal; OpenCode runner selection is covered by the dedicated runner-selection validation.'
CYRUS_PORT=3600 apps/f1/f1 start-session --issue-id issue-1
CYRUS_PORT=3600 apps/f1/f1 view-session --session-id session-1 --limit 20 --offset 0
CYRUS_PORT=3600 apps/f1/f1 stop-session --session-id session-1
```

Key outputs:

- Server healthy, status `ready`.
- Created `issue-1` / `DEF-1`.
- Started `session-1`.
- EdgeWorker routed by `[repo=...]` tag to `F1 Test Repository`.
- Git worktree created under the F1 Cyrus home.
- Session activity view showed thought activities and a final stop response.
- Server stopped gracefully after SIGINT.

## Final Retrospective

F1 validated the repository routing and session activity surface around this change. Direct OpenCode runner execution is covered by the runner-selection and end-to-end validation passes.
