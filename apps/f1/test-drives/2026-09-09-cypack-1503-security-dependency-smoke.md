# Test Drive: CYPACK-1503 Security Dependency Smoke

**Date**: 2026-09-09
**Goal**: Verify the F1 server, issue routing, EdgeWorker session startup, activity rendering, pagination, and clean shutdown after the security dependency updates.
**Test Repo**: `/private/tmp/cypack-1503-f1.UjOvFI/repo`

## Verification Results

### Issue-Tracker
- [x] Issue created
- [x] Issue ID returned
- [x] Issue metadata accessible

### EdgeWorker
- [x] Session started
- [x] Worktree created from local `main`
- [x] Activities tracked
- [x] Agent processed the issue and wrote `SECURITY-NOTE.md`
- [x] Session stopped cleanly

### Renderer
- [x] Thought and action activities rendered coherently
- [x] Activity timestamps were present
- [x] Pagination worked with `--limit 5 --offset 5`

## Session Log

```bash
apps/f1/f1 init-test-repo --path /private/tmp/cypack-1503-f1.UjOvFI/repo
```

Result: the test repository was created successfully with an initial commit.

```bash
CYRUS_PORT=3600 CYRUS_REPO_PATH=/private/tmp/cypack-1503-f1.UjOvFI/repo bun run apps/f1/server.ts
CYRUS_PORT=3600 apps/f1/f1 ping
CYRUS_PORT=3600 apps/f1/f1 status
```

Result: the server started on `http://localhost:3600`, RPC health passed, and status reported `ready`.

```bash
CYRUS_PORT=3600 apps/f1/f1 create-issue \
  --title "CYPACK-1503 dependency smoke" \
  --description "Add a concise SECURITY-NOTE.md stating that the dependency-patched CLI smoke test passed. Keep the change limited to that file." \
  --labels primary
CYRUS_PORT=3600 apps/f1/f1 start-session --issue-id issue-2
CYRUS_PORT=3600 apps/f1/f1 view-session --session-id session-2 --limit 10 --offset 0
```

Result: label routing selected `F1 Test Repository`, the EdgeWorker created the `DEF-2` worktree, Claude started, and the session emitted thought and action activities while processing the requested file.

```bash
CYRUS_PORT=3600 apps/f1/f1 stop-session --session-id session-2
CYRUS_PORT=3600 apps/f1/f1 view-session --session-id session-2 --limit 5 --offset 5
```

Result: the session reached `complete`, pagination returned five of fifteen activities, and SIGINT shut down the F1 server gracefully without an unhandled error.

## Final Retrospective

The patched Vitest and Hono graph preserved the F1 pipeline from issue creation through routing, worktree creation, runner startup, activity rendering, pagination, and shutdown. An initial unlabeled issue correctly produced repository-selection elicitation; the labeled validation issue then exercised the intended end-to-end path.
