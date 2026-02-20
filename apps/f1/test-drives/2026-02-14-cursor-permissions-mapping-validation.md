# Test Drive: Cursor Permissions Mapping Validation

**Date**: 2026-02-14
**Goal**: Validate Cursor project-level permissions mapping from Claude tool permissions and prove permissions are synced before Cursor sessions start (including updates during subroutine transitions).
**Test Repo**: `/tmp/f1-test-drive-cypack-804-perms-20260213-173327`
**Server Port**: `3605`
**Server Log**: `/tmp/f1-cypack-804-permissions-3605.log`

## Verification Results

### Issue-Tracker
- [x] Issue created
- [x] Issue ID returned
- [x] Session started for created issue

### EdgeWorker
- [x] Session routed with `cursor` agent selection (`[agent=cursor]`)
- [x] Cursor runner wrote `.cursor/cli.json` before execution
- [x] Permission sync repeated across subroutine transitions
- [x] Prompted continuation resumed existing cursor session id

### Renderer
- [x] Session activities visible in `view-session`
- [x] Prompt activity captured for follow-up message

## Session Log

1. Start F1 server with Cursor mock mode:
   - `CYRUS_CURSOR_MOCK=1 CYRUS_PORT=3605 CYRUS_REPO_PATH=/tmp/f1-test-drive-cypack-804-perms-20260213-173327 node dist/server.js`
2. Health check:
   - `./f1 ping` -> healthy
3. Create issue + start cursor session:
   - `./f1 create-issue -t "Cursor permission pre-session sync" -d "[agent=cursor] ..."`
   - `./f1 start-session -i issue-1`
4. Send prompted continuation:
   - `./f1 prompt-session -s session-1 -m "Trigger continuation and subroutine transition"`
5. Evidence from server log:
   - `Label-based runner selection for new session: cursor (session session-1)`
   - `CursorRunner] Synced project permissions .../.cursor/cli.json (allow=3, deny=0)`
   - Multiple repeated sync lines during subroutine flow
   - `All tools disabled for subroutine: concise-summary`
   - Later sync reflects update: `Synced project permissions ... (allow=0, deny=0)`
6. Session view:
   - `./f1 view-session -s session-1 -l 12` shows active session + prompted continuation activity.

## Final Retrospective

Cursor permission mapping is now applied as a project-level configuration file (`.cursor/cli.json`) before runner execution and is re-synced as subroutine context changes. The F1 run confirms cursor agent selection, continuation behavior, and programmatic permission updates during a live session flow.
