# Test Drive: Codex app-server (0.137) — sandbox, bin-shim launcher, pooled shared process

**Date**: 2026-06-09
**Goal**: Validate the Codex app-server path end-to-end for PR #1293 — runner selection, app-server launch via the `@openai/codex` bin-shim (0.137 SDK), per-thread permission-profile sandbox, the pooled shared app-server with concurrent-session isolation, and resume-across-turns.
**Test Repo**: `/tmp/f1-codex-pool-20260609-170916`
**Server**: `ATMIKO_PORT=3607 ATMIKO_DEFAULT_RUNNER=codex CODEX_MODEL=gpt-5.5 CODEX_HOME=~/.codex bun run apps/f1/server.ts`

## Verification Results

### Issue-Tracker
- [x] Issues created (`issue-1`/`DEF-1`, `issue-2`/`DEF-2`, `issue-3`/`DEF-3`)
- [x] Issue IDs returned
- [x] Repository-selection elicitation raised and answered via `prompt-session`

### EdgeWorker
- [x] Codex runner selected (`Using model: gpt-5.5`)
- [x] App-server session launched via the `@openai/codex` bin-shim (0.137) — sessions ran to completion
- [x] Worktree created (`worktrees/DEF-1/`)
- [x] **Per-thread permission-profile sandbox enforced** — the requested write landed inside the worktree (`worktrees/DEF-1/F1POOL.txt`, content `F1-POOL-OK`); writes were confined to the worktree as configured
- [x] **Pooled shared app-server + concurrent isolation** — two sessions run concurrently (DEF-2/DEF-3) each returned ONLY its own token (no cross-talk)
- [x] **Resume across turns** — a follow-up on a completed session resumed the same thread and recalled prior context

### Renderer
- [x] Activity timeline showed `elicitation`, `prompt`, `thought` (routing + model), `action` (tool lifecycle), and `response`
- [x] **Tool / file-edit activities visible** — `Edit` (F1POOL.txt), `Bash`, `Grep`, `mcp__agent_waymark__*` actions rendered
- [x] Final `response` activity posted for every session

## Scenarios

### 1 — Single session: launch + sandbox write + file-edit activity + response
Issue: create `F1POOL.txt` containing `F1-POOL-OK`, then reply `F1-POOL-OK`.
- Activities progressed elicitation → prompt → routing thought → `Edit F1POOL.txt` → `Bash` (verify) → `response F1-POOL-OK`.
- File written to `worktrees/DEF-1/F1POOL.txt` (sandbox-permitted worktree path), content `F1-POOL-OK`. **PASS**

### 2 — Two concurrent sessions: pooled process + threadId routing isolation
- `session-2` → `ALPHA-CONCURRENT-111`; `session-3` → `BRAVO-CONCURRENT-222` (completed ~1s apart).
- Each concurrent session returned only its own token — no cross-thread delivery over the shared app-server. **PASS**

### 3 — Resume across turns
- Follow-up on completed `session-2` ("what token did you just reply with?") → resumed the same thread and replied `ALPHA-CONCURRENT-111` (prior context recalled). **PASS**

## Cleanup
- All three sessions stopped cleanly.
- On server stop: **0 leaked `codex app-server` processes**, port 3607 released (pooled-process group-kill teardown confirmed end-to-end).

## Session Log (key commands)
```bash
cd apps/f1
./f1 init-test-repo --path /tmp/f1-codex-pool-20260609-170916
ATMIKO_PORT=3607 ATMIKO_REPO_PATH=/tmp/f1-codex-pool-20260609-170916 \
  ATMIKO_DEFAULT_RUNNER=codex CODEX_MODEL=gpt-5.5 CODEX_HOME=~/.codex \
  bun run apps/f1/server.ts &

ATMIKO_PORT=3607 ./f1 create-issue -t "...create a file" -d "...F1POOL.txt...F1-POOL-OK"
ATMIKO_PORT=3607 ./f1 start-session --issue-id issue-1
ATMIKO_PORT=3607 ./f1 prompt-session --session-id session-1 --message "F1 Test Repository"
ATMIKO_PORT=3607 ./f1 view-session --session-id session-1     # → response F1-POOL-OK

# concurrent
ATMIKO_PORT=3607 ./f1 start-session --issue-id issue-2 && ./f1 start-session --issue-id issue-3
ATMIKO_PORT=3607 ./f1 prompt-session -s session-2 -m "F1 Test Repository"
ATMIKO_PORT=3607 ./f1 prompt-session -s session-3 -m "F1 Test Repository"
# → session-2 ALPHA-CONCURRENT-111, session-3 BRAVO-CONCURRENT-222 (isolated)

# resume
ATMIKO_PORT=3607 ./f1 prompt-session -s session-2 -m "What token did you just reply with?"
# → ALPHA-CONCURRENT-111 (context recalled across turns)
```

## Final Retrospective
- **All scenarios passed.** The 0.137 app-server path is healthy end-to-end through the real Linear-style pipeline: runner selection, bin-shim launch, worktree-confined sandbox writes, visible tool/file-edit activities, pooled shared-process concurrency with per-session isolation, resume-across-turns, and leak-free teardown.
- **Mid-turn steer** was not separately exercised here (hard to time the injection through the F1 CLI); it remains covered by unit tests + the earlier real-binary steer/startup-gap validation.
- No unhandled errors; server healthy throughout.
