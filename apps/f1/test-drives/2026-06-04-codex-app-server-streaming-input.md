# Test Drive: Codex app-server backend + mid-turn streaming input

**Date**: 2026-06-04
**Goal**: Validate the new Codex `app-server` backend end-to-end through the real EdgeWorker pipeline, including mid-turn comment steering (`turn/steer`).
**Test Repo**: `/tmp/f1-codex-appserver-<ts>` (rate-limiter scaffold)
**Config**: `ATMIKO_DEFAULT_RUNNER=codex CODEX_USE_APP_SERVER=1 CODEX_MODEL=gpt-5.5` (env-gated F1 server runner selection)

## Verification Results

### Issue-Tracker
- [x] Issue created (`DEF-1`)
- [x] Issue ID returned
- [x] Issue metadata accessible

### EdgeWorker (Codex app-server backend)
- [x] Session started with `defaultRunner: codex` + `codexUseAppServer: true`
- [x] `CodexRunner` reported `hasCodexSubscription: true` and configured MCP
- [x] Worktree created at `worktrees/DEF-1`
- [x] Activities tracked (thought / action)
- [x] Tool actions mapped correctly: `Bash`, `Grep`, `Edit`, `mcp__codex_apps__linear_*`
- [x] Agent completed the task and edited `src/index.ts`

### Mid-turn streaming input (the headline feature)
- [x] A comment injected **while the Codex turn was active** was steered into the
      live turn rather than restarting it.
- [x] Observable acknowledgement: thought activity **“I've queued up your message
      as guidance”** immediately after the comment, then **“Got it. I'll include
      `subtract(a, b)` alongside `multiply`…”**.
- [x] The steered request was incorporated into the work product — final
      `src/index.ts` contains all three functions:
      `divide` (original issue), `multiply` (1st prompt), `subtract` (mid-turn steer).

### Renderer
- [x] Activity types correct (`thought`, `action`, `prompt`, `elicitation`)
- [x] Timestamps present
- [x] Content well-formed

## Session Log (key moments)

```
4:47:42  AgentSessionEvent created → repo elicitation ("Which repository…?")
4:47:52  prompt (repo selection / "multiply") → codex session initialized (gpt-5.5)
4:48:28–36  active turn: Bash/Grep/Edit actions implementing divide+multiply
4:48:39  prompt "Also add a subtract(a,b) function too."  ← mid-turn
4:48:39  thought "I've queued up your message as guidance"  ← turn/steer
4:48:48  thought "Got it. I'll include subtract(a, b) alongside multiply…"
4:49:16  Edit src/index.ts — "adding three named exports"
```

Final `src/index.ts`:
```
export function subtract(a, b) { … }
export function multiply(a, b) { … }
export function divide(a, b) { … }
```

## Pass/Fail

**PASS.** Server started, issue created, Codex app-server session ran through the
real EdgeWorker pipeline, activities rendered, the mid-turn comment was injected
into the active turn (not a restart), and the steered request landed in the
output. No unhandled errors (one benign `git fetch` warning — the test repo has
no remote).

## Notes / Follow-ups
- F1's `defaultRunner`/`codexUseAppServer` selection was added env-gated in
  `apps/f1/server.ts` (default F1 behavior unchanged).
- The "Adding prompt to existing stream" EdgeWorker log is `debug`-level and not
  visible at the F1 server's INFO level; the steering was instead confirmed via
  the agent's own activity stream and the final file contents.
- Complementary lower-level validation lives in
  `packages/codex-runner/experiments/` (backend + full-runner steering against
  the live binary) and the package's unit/replay tests.
