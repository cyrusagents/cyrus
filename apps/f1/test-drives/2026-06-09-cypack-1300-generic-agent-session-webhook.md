# Test Drive: CYPACK-1300 — Generic Agent Session Webhook

**Date**: 2026-06-09
**Goal**: Validate the consolidated agent-session lifecycle and generic webhook route at runtime.
**Test Repo**: `/tmp/f1-test-drive-cypack-1300-1781033488`
**F1 cyrusHome**: `/var/folders/xv/c55x22nd6lv8kq9fccch04d40000gp/T/cyrus-f1-1781033494760`

## Verification Results

### Issue-Tracker
- [x] F1 server started.
- [x] F1 RPC health check passed.
- [x] F1 status endpoint returned `ready`.

### EdgeWorker
- [x] `POST /agent-session-webhook` registered during EdgeWorker startup.
- [x] Synthetic Slack chat event dispatched through `/cli/dispatch-chat`.
- [x] Shared `AgentSessionLifecycleService` created and bound session `slack-f1-1781033510.626`.
- [x] Per-thread workspace created at `slack-workspaces/C_CYPACK1300_1781033510.626`.
- [x] Runner config assembled through the shared lifecycle path with `platform=slack`.
- [x] Authenticated generic webhook smoke event returned HTTP 200.
- [x] F1 server stopped cleanly.

### Renderer
- [x] `list-chat-threads` returned the bound thread/session pair.
- [x] `view-chat-thread` returned coherent running/completed status and message count.
- [x] Final assistant text was available from the F1 chat inspection endpoint.

## Session Log

```bash
$ apps/f1/f1 init-test-repo --path /tmp/f1-test-drive-cypack-1300-1781033488
✓ Test repository created successfully

$ CYRUS_DISABLE_REMOTE_SESSION_STORE=1 CYRUS_PORT=3600 \
    CYRUS_REPO_PATH=/tmp/f1-test-drive-cypack-1300-1781033488 \
    bun run apps/f1/server.ts
✓ Server started successfully
Registered POST /agent-session-webhook endpoint

$ CYRUS_PORT=3600 apps/f1/f1 ping
✓ Server is healthy

$ CYRUS_PORT=3600 apps/f1/f1 status
✓ Server Status
  Status: ready

$ CYRUS_PORT=3600 apps/f1/f1 start-chat-session \
    --channel C_CYPACK1300 \
    --user U_TEST \
    --text "Validate the consolidated agent-session lifecycle path. Reply briefly."
✓ Chat event dispatched
  Event ID: f1-1781033510.626
  Thread Key: C_CYPACK1300:1781033510.626

$ CYRUS_PORT=3600 apps/f1/f1 list-chat-threads
✓ Found 1 chat thread(s):
  C_CYPACK1300:1781033510.626: slack-f1-1781033510.626

$ CYRUS_PORT=3600 apps/f1/f1 view-chat-thread \
    --thread-key C_CYPACK1300:1781033510.626
✓ Chat thread C_CYPACK1300:1781033510.626
  Running: false
  Message Count: 80

$ node -e '<post authenticated agent_session.stopped payload to /agent-session-webhook>'
{"status":200,"body":{"success":true}}
```

Key EdgeWorker log lines:

```text
Registered POST /agent-session-webhook endpoint
Processing slack webhook: f1-1781033510.626
slack workspace created at: .../slack-workspaces/C_CYPACK1300_1781033510.626
Creating chat session
[event:claude_query_options] ... "cqo.allowedToolsPreview":"Read ... mcp__slack ..."
Session completed (subtype: success)
Received generic agent-session webhook agent_session.stopped (...)
Processing generic webhook: ...
Ignoring stop request for unbound generic thread f1-generic-thread
Server stopped gracefully
```

## Final Retrospective

What worked:
- The Slack chat route now exercises `AgentSessionLifecycleService` instead of a separate `ChatSessionHandler`.
- The shared lifecycle created a session through the shared `AgentSessionManager`, assigned a runner session id, emitted messages, and completed normally.
- The generic webhook route registered and accepted an authenticated, schema-valid webhook at runtime.

Known F1 limitation:
- The synthetic Slack channel does not exist in Slack, so posting the final reply logged `channel_not_found`. This is expected for the F1 synthetic route and did not block lifecycle validation.

Outcome: **Pass.**
