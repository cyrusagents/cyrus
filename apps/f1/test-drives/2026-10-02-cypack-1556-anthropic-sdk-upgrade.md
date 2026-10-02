# Test Drive: Anthropic SDK 0.3.287 Upgrade (CYPACK-1556)

**Date**: 2026-10-02
**Goal**: Verify that a Claude-backed F1 session initializes through Agent SDK 0.3.287 with the refreshed Cyrus tool catalog.
**Tested source**: Working tree based on `8533e11a5a3de48a621f3e120c9679a43f87e868`
**Test Repo**: Fresh rate-limiter fixture under `/private/tmp/cypack-1556-f1.gfgLb7/repo`

## Verification Results

### Issue Tracker

- [x] Issue created
- [x] Issue ID returned
- [x] Issue metadata accessible

### EdgeWorker

- [x] Session started
- [x] Worktree created
- [x] Activities tracked
- [x] Agent SDK initialized and assigned Claude session `9e2fc6fe-e118-4945-845b-69467368a2c2`
- [x] The refreshed 30-tool built-in catalog reached the Agent SDK
- [ ] Agent completed the requested repository inspection

### Renderer

- [x] Activity format correct
- [x] Pagination works
- [x] Search works
- [x] Session and server stopped cleanly

## Session Log

- `CYRUS_PORT=3600 apps/f1/f1 ping` reported the server healthy, and `status` reported it ready.
- Created `DEF-1`, selected `F1 Test Repository` through routing elicitation, and confirmed the worktree was created from local `main`.
- EdgeWorker passed the expected 30 configured built-in tools to Agent SDK 0.3.287, including `TaskCreate`, `TaskUpdate`, `TaskGet`, `TaskList`, `LSP`, `Workflow`, and `ReportFindings`.
- Agent SDK 0.3.287 assigned a Claude session and emitted system/model activities.
- The live model turn returned `401 OAuth access token has expired` after SDK initialization, so no repository-inspection response was produced.
- Pagination (`--limit 2 --offset 1`) and activity search (`--search Routing`) returned the expected subsets.
- `stop-session` succeeded and the F1 server shut down cleanly on `SIGINT`.

## Final Retrospective

Agent SDK 0.3.287 initializes correctly through the F1 EdgeWorker path and receives the complete 30-tool Cyrus catalog. Issue creation, repository selection, worktree setup, activity rendering, pagination, search, stop, and graceful shutdown all worked. A completed model response remains unverified because the environment's Claude OAuth token is expired; rerun this drive after re-authenticating Claude to close that external validation gap.
