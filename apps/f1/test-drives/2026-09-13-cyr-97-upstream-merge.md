# Test Drive: CYR-97 upstream merge smoke test

**Date**: 2026-09-13
**Goal**: Verify the merged EdgeWorker, issue tracker, Codex runner, and activity renderer operate end to end.
**Test Repo**: `/tmp/f1-cyr-97-drive`

## Verification Results

### Issue-Tracker

- [x] Issue created
- [x] Issue ID returned (`issue-1`, `DEF-1`)
- [x] Issue metadata accessible

### EdgeWorker

- [x] Server started on port 3600 and reported ready
- [x] Session started (`session-1`)
- [x] Worktree/session processing completed
- [x] Activities tracked throughout the run
- [x] Agent correctly identified the token bucket implementation

### Renderer

- [x] Thought, action, and response activities rendered coherently
- [x] Pagination worked at offsets 0 and 10
- [x] Final response appeared and session reached `complete`

## Session Log

The F1 shell wrapper requires Bun, which was unavailable in the validation environment. The already-built Node-compatible CLI and server entry points were used directly instead.

1. Initialized a fresh test repository with `node apps/f1/dist/src/cli.js init-test-repo`.
2. Started `apps/f1/dist/server.js` with `CYRUS_PORT=3600` and the fresh repository path.
3. Verified `ping` and `status`; the server reported `ready`.
4. Created a read-only inspection issue and started `session-1`.
5. Observed 16 activities, including thoughts, tool actions, and a final response.
6. Confirmed paginated activity output and a final `complete` session state.
7. Sent the stop command and confirmed graceful server shutdown.

## Final Retrospective

The merged application passed the F1 smoke path end to end. The Node entry points are a viable fallback for environments without Bun; the normal `./f1` wrapper remains unchanged.
