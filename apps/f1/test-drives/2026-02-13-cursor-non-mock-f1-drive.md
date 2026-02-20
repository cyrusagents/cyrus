# Test Drive: Cursor Non-Mock Session Validation

**Date**: 2026-02-13
**Goal**: Validate F1 CLI end-to-end with a `/tmp` test repo using Claude as control and Cursor as non-mock runner.
**Test Repo**: `/tmp/f1-test-drive-cursor-1770951895`
**Server Port**: `3611`

## Verification Results

### Issue-Tracker
- [x] Issue created with `create-issue`
- [x] Issue ID/identifier returned (`issue-1` / `DEF-1`)
- [x] Metadata accessible via `view-session`

### EdgeWorker
- [x] Session started with `start-session` (`session-1`)
- [x] Worktree created under temp Cyrus home
- [x] Activities tracked in timeline
- [x] Agent processed issue with non-mock Cursor runner

### Renderer
- [x] Activity format visible and coherent (`thought`, `response`)
- [x] Session activity retrieval works with `--limit/--offset`
- [x] Final `response` activity posted

## Session Log

1. Initialized fresh repo:
   - `apps/f1/f1 init-test-repo --path /tmp/f1-test-drive-cursor-1770951895`
2. Started F1 server:
   - `CYRUS_PORT=3611 CYRUS_REPO_PATH=/tmp/f1-test-drive-cursor-1770951895 bun run apps/f1/server.ts`
3. Confirmed health:
   - `apps/f1/f1 ping`
4. Created and started non-mock Cursor issue:
   - Description included `[agent=cursor]` and `[model=gpt-5]`
   - `apps/f1/f1 start-session --issue-id issue-1`
5. Observed session output via `view-session`:
   - Procedure selected: `simple-question`
   - Model notifications posted
   - Final response activity posted: `cursor runner works.`

## Final Retrospective

- Non-mock Cursor session now completes successfully through F1 CLI with a final response activity.
- Cursor model alias normalization (`gpt-5` -> `auto`) removed the immediate runner failure path.
- Cursor event mapping now captures assistant-schema output, improving response quality from generic completion text to actual assistant response text.
