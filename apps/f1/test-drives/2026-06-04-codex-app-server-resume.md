# Test Drive: Codex app-server — resume between turns (real pipeline)

**Date**: 2026-06-04
**Goal**: Validate the between-turns resume path for the Codex app-server backend
through the real EdgeWorker pipeline (a second prompt after a turn fully completes
must recall prior context via `thread/resume` in a fresh app-server process).
**Config**: `ATMIKO_DEFAULT_RUNNER=codex CODEX_USE_APP_SERVER=1 CODEX_MODEL=gpt-5.5`

## Why this drive
Steering (mid-turn) and activity/tool mapping were validated in the
2026-06-04 streaming-input drive. The standalone `resume-across-processes.mjs`
experiment proved the backend's resume, but not the EdgeWorker wiring
(`resumeAgentSession` → `CodexRunner(resumeSessionId)` → `thread/resume`). This
drive closes that — the most common production path (every follow-up comment that
lands after a turn ends).

## Result: PASS

1. Turn 1 (`F1 Test Repository. Also: the project codename is FALCON-9 — just
   acknowledge it briefly.`) →
   `response: "Acknowledged: the project codename is FALCON-9."`,
   `Session completed (subtype: success)`.
2. Server log confirmed the app-server backend + MCP loading in the real pipeline:
   `[CodexRunner] Configured 1 MCP server(s) for codex config`.
3. After turn 1 finalized, turn 2 (`What is the project codename I told you
   earlier? Reply with just the codename.`) took the **resume path**:
   ```
   [resumeAgentSession] needsNewSession=false, resumeSessionId=019e952a-cc98-7621-aec4-7859117e9c6b
   ```
4. The resumed thread (fresh app-server process) **recalled context**:
   `response: "FALCON-9"`, second `Session completed (subtype: success)`.

## Coverage of the Codex app-server backend in the real pipeline
- [x] Mid-turn steering (prior drive)
- [x] Activity / tool-call mapping (prior drive)
- [x] Resume between turns via real EdgeWorker `resumeAgentSession` (this drive)
- [x] MCP server loads under app-server (`Configured 1 MCP server(s)`)
- [x] Clean lifecycle completion (`subtype: success`) on both turns

## Not covered here
- Multi-repo *workspace* sessions (`additionalDirectories` →
  `sandbox_workspace_write.writable_roots`): F1's multi-repo mode is repo
  *routing*, not a single session spanning repo sub-worktrees (the
  orchestrator/sub-issue flow). The writable_roots wiring is unit-tested
  (correct param emitted); an end-to-end check needs the multi-repo
  orchestration flow.
- git-gh subroutine push/PR: F1 test repos have no real remote.
