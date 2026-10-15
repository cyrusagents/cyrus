# Test Drive: Claude Agent SDK 0.3.300 runtime

**Date**: 2026-10-15
**Goal**: Verify the upgraded Claude Agent SDK starts through Cyrus with the expected tool and permission configuration, then executes a bounded Read/Bash scenario.
**Test Repo**: `/private/tmp/cypack-1579-f1-20261015`

## Verification Results

### Issue-Tracker

- [x] Issue `DEF-1` created
- [x] Session `session-1` created
- [x] Repository selection and routing activity rendered

### EdgeWorker

- [x] Worktree created from the local `main` branch
- [x] SDK session initialized (`7ced6667-37da-4dff-8127-c2e67bca89b8`)
- [x] Query options included `permissionMode: "default"`
- [x] Query options included the refreshed 30-tool SDK surface
- [ ] Read and Bash executed
- [ ] Final response returned `SDK_RUNTIME_OK`

The installed Claude login is revoked server-side. The SDK emitted `Failed to authenticate: OAuth token revoked` after initialization and before any requested tool call, so authenticated runtime acceptance remains blocked outside this change.

### Renderer

- [x] Elicitation, prompt, thought, model notification, and error activities rendered coherently
- [x] Pagination returned stable two-activity pages at offsets 0 and 2
- [x] Stop produced a final response activity

### Cleanup

- [x] Session stop signal handled
- [x] EdgeWorker state saved
- [x] F1 server stopped gracefully

## Session Log

```text
./apps/f1/f1 init-test-repo --path /private/tmp/cypack-1579-f1-20261015
CYRUS_PORT=3600 CYRUS_REPO_PATH=/private/tmp/cypack-1579-f1-20261015 bun run apps/f1/server.ts
CYRUS_PORT=3600 ./apps/f1/f1 create-issue --title "Validate Claude Agent SDK 0.3.300 runtime" --description "Read src/rate-limiter.ts, run pwd and git status --short, then respond with SDK_RUNTIME_OK. Do not edit files."
CYRUS_PORT=3600 ./apps/f1/f1 start-session --issue-id issue-1
CYRUS_PORT=3600 ./apps/f1/f1 prompt-session --session-id session-1 --message "f1-test-repo"
CYRUS_PORT=3600 ./apps/f1/f1 view-session --session-id session-1 --limit 2 --offset 0
CYRUS_PORT=3600 ./apps/f1/f1 view-session --session-id session-1 --limit 2 --offset 2
CYRUS_PORT=3600 ./apps/f1/f1 stop-session --session-id session-1
```

## Final Retrospective

The upgraded SDK starts successfully through the issue-tracker, routing, worktree, and activity pipeline with the intended Cyrus permission boundary. Final runtime acceptance requires the existing owner to reconnect the intended Claude account with `claude auth login --claudeai`, verify `claude auth status`, and rerun this bounded scenario until Read, Bash, and `SDK_RUNTIME_OK` complete without an error result.
