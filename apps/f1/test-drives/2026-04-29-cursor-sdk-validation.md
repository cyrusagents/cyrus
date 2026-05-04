# Test Drive: Cursor SDK Migration Validation (CYPACK-1149)

**Date**: 2026-04-29
**Goal**: Validate the new `@cursor/sdk`-based cursor-runner from PR #1169 — confirm sessions start via `Agent.create()`, permission hooks gate tool calls, and tool/file activity reaches the timeline.
**Branch**: `cypack-1149`
**Test Repo**: `/tmp/f1-cursor-sdk-1777497673` (rate-limiter starter)

## Verification Results

### Issue-Tracker
- [x] Issue created (`DEF-1`, "Implement fixed window rate limiter")
- [x] Issue ID returned by RPC
- [x] `cursor` label applied for label-based runner routing

### EdgeWorker
- [x] Session started via `f1 start-session`
- [x] Repository elicitation prompt presented and resolved via `f1 prompt-session`
- [x] Worktree created at `/tmp/cyrus-f1-*/worktrees/DEF-1`
- [x] Label-based runner selection picked `cursor`
- [x] **Cyrus permission hooks installed** at `<worktree>/.cursor/hooks.json` (allow=36, deny=836, backup=yes) — confirms the new `.cursor/hooks.json` + `cyrus-permission-check.mjs` artifacts land correctly
- [x] **`Agent.create()` succeeded**, returned local agentId `agent-afbd9b56-c3e2-47f1-9ada-56e2850da01d`
- [x] Streaming run flowed cleanly under Node (under Bun, HTTP/2 frame-size errors crashed the connection — see "Issue 1" below)
- [x] `Read` tool invocations on real files (`package.json`, `tsconfig.json`, `src/index.ts`, `src/types.ts`, `src/rate-limiter.ts`, `README.md`) — file paths surfaced correctly in action payloads

### Renderer
- [x] Activity types: `prompt`, `thought`, `action`, `elicitation`
- [x] `action` payloads JSON-shaped with `action`, `parameter`, `result` fields
- [ ] **Text response fragmentation** — assistant text arrived in many tiny per-token "thought" activities ("Expl" / "oring the codebase to" / " locate" / ...) instead of one consolidated response. See "Issue 2" below.
- [x] Pagination works (`--limit`, `--offset`)

### Sessions
- [x] Session ID persisted as the SDK local agentId

## Issues Found

### Issue 1 — Bun + `@cursor/sdk` HTTP/2 incompatibility (environmental, not in our code)

Under `bun run server.ts`, the SDK's underlying `@connectrpc/connect-node` HTTP/2 client crashed shortly after `agent.send()` with:

```
ConnectError: [internal] Stream closed with error code NGHTTP2_FRAME_SIZE_ERROR
ERR_HTTP2_STREAM_ERROR
```

Reproduced consistently. Switching the F1 server runtime to Node (`node dist/server.js`) makes it go away — the same prompt streams cleanly and the agent does real work. This is a known Bun ↔ HTTP/2-gRPC interop issue and not in our runner code (verified during the learning-test phase that the SDK runs fine under Node alone).

**Action**: F1 should run under Node when validating the cursor runner, or wait for Bun's HTTP/2 fix. Documented for the next driver. **Not a CYPACK-1149 blocker.**

### Issue 2 — Assistant text streamed as per-token "thought" activities

The new SDK emits `assistant` events with partial content as text streams in. The runner's `mapSdkEventToInternalMessages` currently emits one `SDKAssistantMessage` per event without coalescing, which AgentSessionManager renders as a flood of one-word `thought` activities. Functionally correct — the content is all there — but visually noisy in the Linear timeline.

**Action**: Buffer assistant text deltas in CursorRunner and emit one consolidated `SDKAssistantMessage` per assistant turn. Tracking as a follow-up.

### Issue 3 — Default model `gpt-5` rejected by SDK (fixed in this drive)

First run errored with `ConfigurationError: Cannot use this model: auto`. Two causes:
1. Legacy `normalizeCursorModel` mapped `gpt-5 → auto` (CLI alias, not an SDK model id).
2. `RunnerSelectionService.getDefaultModelForRunner("cursor")` hardcoded `"gpt-5"`, which isn't in the SDK's accepted list either.

**Fix landed**:
- `normalizeCursorModel` now maps both `gpt-5` and `auto` to `default` (a real SDK id) for backwards compat.
- `RunnerSelectionService` defaults cursor to `composer-2` (Cursor's named default per blog/docs) and accepts `cursorDefaultModel` / `cursorDefaultFallbackModel` config overrides.
- Schema additions in `packages/core/src/config-schemas.ts`.
- Config wiring in `ConfigManager.ts`.

After the fix, the next run logged `Model override via selector: composer-2` and `Agent.create()` succeeded.

## Session Log (highlights)

```
[CursorRunner] Installed Cyrus permission hooks at .../worktrees/DEF-1/.cursor/hooks.json (allow=36, deny=836, backup=yes)
[CursorRunner] Sending prompt to agent agent-afbd9b56-c3e2-47f1-9ada-56e2850da01d (resume=false)
[AgentSessionManager] Created thought activity activity-{4..16}     # streamed model output (fragmented — see Issue 2)
[AgentSessionManager] Created action activity activity-{17..43+}    # Read tool calls on package.json, tsconfig.json, src/*, README.md
```

## Pass / Fail

**PASS on the core migration.** The Cursor runner now goes through `@cursor/sdk` end-to-end:
- Agent.create with `local: { cwd: [...], settingSources: ["project"] }` works.
- Permission hooks (`.cursor/hooks.json` + `cyrus-permission-check.mjs`) install at session start.
- Tool calls stream through and surface as Cyrus activities.
- Resume path validated by unit tests; live resume across F1 sessions is a follow-up.

**Two follow-ups identified** (Issue 1 = environmental Bun bug, Issue 2 = text fragmentation polish). Neither blocks merging PR #1169.

## Final Retrospective

- The locked-in design decisions from the learning-test phase all held up under live validation.
- The model-id mismatch is the only "lessons learned" item — the legacy CLI's lenient model resolver hid the fact that the SDK enforces a strict allowlist. Worth documenting in any new harness checklist.
- The Bun crash burned ~10 minutes; consider noting in F1 docs that runs should use Node when the runner-under-test depends on `@connectrpc/connect-node`.
