# Test Drive: Multiple Private Linear Apps

**Date**: 2026-09-16
**Goal**: Verify workspace-scoped app credentials and preserve the Codex issue-to-response flow.
**Test repo**: `/tmp/f1-private-linear-apps`

## Verification results

### Private app isolation

- [x] Two private apps can deliver signed webhooks to the same endpoint.
- [x] A legacy workspace can still use the global signing secret.
- [x] Cross-workspace signatures, unknown workspaces, and missing scoped secrets are rejected.
- [x] Rotation uses the current configured signing secret.
- [x] Concurrent workspace token refreshes use the matching client credentials and preserve both results, app credentials, and workspace metadata.
- [x] Authorization adds a workspace without replacing existing workspace credentials or repositories.

These checks use synthetic credentials in real Fastify route tests and mocked
OAuth endpoints. No production Linear events or tokens are used.

### Issue tracker

- [x] F1 server healthy on port 3600.
- [x] Created `DEF-2` (`issue-2`) with the `primary` routing label.
- [x] Issue title and description accessible in the session.

### EdgeWorker

- [x] Started `session-2`.
- [x] Created an isolated worktree for `DEF-2` from the test repo's local `main`.
- [x] Codex / `gpt-5.5` read the README without modifying the repository.
- [x] Session stopped cleanly; F1 server shut down.

### Activity rendering

- [x] Nine timestamped activities, including thoughts, tool actions, and a final response.
- [x] Final response: `The project title is **Simple Rate Limiter**.`
- [x] `--limit 1 --offset 8` returned only that final response.
- Search was not exercised; no activity-rendering code changed.

## Session log

```text
f1 init-test-repo --path /tmp/f1-private-linear-apps
ATMIKO_PORT=3600 ATMIKO_REPO_PATH=/tmp/f1-private-linear-apps ATMIKO_DEFAULT_RUNNER=codex bun run apps/f1/server.ts
f1 ping                 -> healthy
f1 status               -> ready
f1 create-issue ... --labels primary -> issue-2 / DEF-2
f1 start-session --issue-id issue-2  -> session-2
f1 view-session --session-id session-2 --limit 10 --offset 0 -> 9 activities
f1 view-session --session-id session-2 --limit 1 --offset 8 -> expected response
f1 stop-session --session-id session-2 -> stopped
```

## Retrospective

The first test issue omitted a routing label, so Atmiko correctly asked which
repository to use. That session was stopped; the labeled issue completed the
read-only smoke test. Private-app verification is covered separately by the
transport and EdgeWorker integration tests because F1 uses a local issue tracker.
Installing a second real Linear app still requires its owner's OAuth consent.
