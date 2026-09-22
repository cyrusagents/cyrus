# Test Drive: OpenCode Watchdog and GitHub PR Queue

**Date**: 2026-08-24
**Goal**: Validate the EdgeWorker issue-session lifecycle after adding OpenCode inactivity handling and GitHub PR queue release on terminal results.
**Test Repo**: `/tmp/f1-test-drive-20260824-opencode-watchdog`

## Verification Results

### Issue-Tracker
- [x] F1 server started on port 3600.
- [x] Created `issue-1` and `issue-2`.
- [x] `issue-2` was routed to the configured repository using `[repo=f1-test-repo]`.

### EdgeWorker
- [x] Started `session-2` for `issue-2`.
- [x] The session emitted startup, routing, and model-selection activities.
- [x] Stopped the synthetic sessions cleanly.
- [ ] Agent task execution could not run because the local Claude CLI is not authenticated.

### Renderer
- [x] `view-session --limit 10 --offset 0` displayed four timestamped, readable activities.
- [x] The authentication failure was surfaced as a readable error activity.

## Session Log

```text
ATMIKO_PORT=3600 ./f1 ping
  Server is healthy

ATMIKO_PORT=3600 ./f1 create-issue ... [repo=f1-test-repo]
  ID: issue-2

ATMIKO_PORT=3600 ./f1 start-session --issue-id issue-2
  Session ID: session-2

ATMIKO_PORT=3600 ./f1 view-session --session-id session-2 --limit 10 --offset 0
  Total Activities: 4
  thought: request received
  thought: routing selected F1 Test Repository
  thought: model selected
  error: Not logged in - Please run /login

ATMIKO_PORT=3600 ./f1 stop-session --session-id session-2
  Session stopped successfully
```

## Final Retrospective

The F1 control plane and activity rendering behaved correctly. Full agent execution could not be validated in this environment because the installed Claude CLI has no authenticated session. The OpenCode inactivity watchdog and warm-runner GitHub PR queue behavior are covered by the package regression tests.
