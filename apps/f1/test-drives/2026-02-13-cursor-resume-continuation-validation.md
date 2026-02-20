# Test Drive: Cursor Resume Continuation Validation

**Date**: 2026-02-13
**Goal**: Verify cursor continuation uses an existing session id (resume behavior) instead of starting fresh context for prompted comments.
**Test Repo**: `/tmp/f1-test-drive-cypack-804-20260213-150310`
**Server Port**: `3603`
**Server Log**: `/tmp/f1-cypack-804-server-3603.log`

## Verification Results

### Issue-Tracker
- [x] Issue created
- [x] Issue ID returned
- [x] Issue metadata accessible

### EdgeWorker
- [x] Session started
- [x] Worktree created
- [x] Activities tracked
- [x] Prompted comment routed to existing session
- [x] Resume session id present and stable in continuation path

### Renderer
- [x] Activity payload format is coherent (`thought` and `prompt` visible)
- [x] Pagination works (`view-session --limit/--offset`)
- [x] Session stop works (`stop-session` successful)

## Session Log

1. Started F1 server with cursor mock mode:
   - `CYRUS_CURSOR_MOCK=1 CYRUS_PORT=3603 CYRUS_REPO_PATH=/tmp/f1-test-drive-cypack-804-20260213-150310 node apps/f1/dist/server.js`
2. Health checks passed:
   - `./f1 ping` -> `Server is healthy`
   - `./f1 status` -> `Status: ready`
3. Created issue and started session:
   - `./f1 create-issue -t "Cursor prompt continuation resume check" -d "[agent=cursor] ..."`
   - `./f1 start-session -i issue-1` -> `Session ID: session-1`
4. Sent follow-up comment to active session:
   - `./f1 prompt-session -s session-1 -m "Follow-up comment for continuation check"` -> `Message sent successfully`
5. Confirmed continuation on existing session and resume id usage in server log:
   - `[EdgeWorker] Found existing session session-1 for new user prompt`
   - `[EdgeWorker] Resuming Claude session for session-1 (prompted webhook (existing session))`
   - `[resumeAgentSession] needsNewSession=false, resumeSessionId=5b4951a5-87f0-4b1c-9eb1-071825331a2f`
   - Repeated continuation calls retained the same `resumeSessionId` value.
6. Verified activity rendering and pagination:
   - `./f1 view-session -s session-1 -l 10 -o 0`
   - `./f1 view-session -s session-1 -l 5 -o 5`
7. Stopped session:
   - `./f1 stop-session -s session-1` -> `Session stopped successfully`

## Final Retrospective

The continuation path now resolves a cursor session as resumable (`needsNewSession=false`) and passes a concrete `resumeSessionId` during prompted follow-ups. This directly addresses the fresh-context regression for cursor comment continuations. The regression is additionally covered by a new unit test in edge-worker runner-selection coverage.
