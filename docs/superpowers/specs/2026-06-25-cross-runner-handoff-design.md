# Cross-Runner Handoff — Design

**Date:** 2026-06-25
**Status:** Approved (design phase)

## Goal

Let a Linear issue be started with one runner (Claude or Codex) and later handed
to the other runner so it continues from the existing work, files, branch, and PR
state in the **same worktree**. Handoff is sequential, never concurrent.

## UX

- Initial runner selection is unchanged: `[agent=claude]` / `[agent=codex]`
  description tags (and labels) still start exactly one runner.
- New comment commands:
  - `@Cyrus /handoff codex`
  - `@Cyrus /handoff claude`
- Normal comments without `/handoff` still go to the currently active runner.
- If no runner is active, `/handoff <runner>` starts the requested runner for
  that issue.
- If the active runner cannot be stopped safely, Cyrus posts a Linear comment
  explaining handoff is blocked and keeps the current runner.

## Decisions (locked)

1. **Session model — reuse same session in place.** Keep the same
   `CyrusAgentSession` and the same Linear agent-session thread; swap
   `agentRunner` in place, clear the old runner's `<x>SessionId` binding, and
   start the target fresh in the same worktree with the snapshot prompt. This
   keeps one continuous Linear timeline and naturally enforces one-active-runner.
   (Cross-runner *transcript* resume is impossible — a Claude session id is
   meaningless to Codex — so the target always starts fresh regardless;
   continuity is delivered via the shared worktree plus the injected snapshot.)
2. **Blocked trigger — stop + timeout.** Request stop and wait up to a timeout
   (~30s) for the runner to reach a stopped state. If it doesn't stop in time,
   post the "handoff blocked" comment and keep the current runner.
3. **Target runners — claude & codex only.** Other targets (`gemini`, `cursor`)
   are rejected with an error comment.

## Architecture

One new focused, unit-testable service plus one thin orchestration method on
`EdgeWorker`, following the existing "EdgeWorker delegates to services" pattern
(`ActivityPoster`, `RunnerSelectionService`, `GitService`).

### `HandoffService` (`packages/edge-worker/src/HandoffService.ts`)

Logic-heavy, no live-runner wiring, takes an injected `GitService` so it is
testable:

- `parseHandoffCommand(text): { targetRunner: "claude" | "codex"; remainder: string } | null`
- `buildSnapshot(args): Promise<HandoffSnapshot>` — gathers git/PR/summary state
- `buildHandoffPrompt(snapshot, userText): string` — formats the
  `<handoff_context>` block plus the user's trailing instruction

### `EdgeWorker.handleHandoffCommand(...)`

Thin orchestration owning the runner/session wiring (stop → snapshot → start).
Lives in `EdgeWorker` because it needs `createRunnerForType`,
`buildAgentRunnerConfig`, and `agentSessionManager`.

## Command parsing

In `handleUserPromptedAgentActivity()`, immediately after `activityBody` is
extracted and **before** the normal-routing branch (a sibling to the existing
`stop` check), parse `/\/handoff\s+(\w+)/i`:

- Tolerant of an optional leading `@Cyrus` mention.
- Text after the command (e.g. `/handoff codex also add tests`) becomes the
  target runner's user instruction (`remainder`).
- The captured target is validated against `{claude, codex}`. An unknown target
  (e.g. `/handoff gemini`) → error comment, no state change.

## Orchestration flow

```
parse /handoff <target>
 ├─ invalid target            → post error comment, stop
 ├─ find active session(s) for issue; determine source runner type
 ├─ target == source          → post "already running <target>" comment, stop (no-op)
 ├─ a runner is active:
 │    requestSessionStop(sessionId); runner.stop()
 │    await stop-confirmed (poll isRunning, timeout ~30s)
 │      └─ still running after timeout → post BLOCKED comment, keep current runner, stop
 ├─ no runner active          → skip stop, start target directly
 ├─ build HandoffSnapshot (source worktree/branch/git/PR/summary)
 ├─ rebind session: clear old runner's <x>SessionId, set agentRunner = target
 ├─ build target config with FORCED runnerType = target (bypass sticky/label selection)
 └─ createRunnerForType(target) → addAgentRunner → start with snapshot-injected prompt
```

The one-active-runner invariant holds by construction: same worktree, source
stopped before target starts.

## Snapshot & prompt injection

`HandoffSnapshot` fields:

- `sourceRunner`, `targetRunner`
- `issueId`, `sessionId`
- `worktreePath`, `branch`
- `gitStatus` (porcelain)
- `recentCommits` (last ~5)
- `diffSummary` (`--stat`)
- `prLink` (best-effort via session metadata / `gh pr view`; omitted if
  unavailable)
- `latestSummary` (from `lastAssistantBodyBySession`; omitted if absent)

The snapshot is injected into the target's starting prompt as a
`<handoff_context>` XML block (consistent with Cyrus's existing XML prompt blocks
such as `<repository_routing_context>`), followed by the user's trailing
instruction, or a sensible default ("Continue the work in this worktree.") when
the comment had none.

## Forcing the runner type

Today `RunnerConfigBuilder` (the resume-override logic, ~lines 333–354) forces
the runner back to whatever the session's `<x>SessionId` is. Handoff needs an
explicit escape hatch: thread an optional `runnerTypeOverride?: RunnerType`
through `buildAgentRunnerConfig` → `buildIssueConfig` that, when set, **bypasses
`determineRunnerSelection` and the sticky-resume logic**. Combined with clearing
the old `<x>SessionId` on rebind, the target starts clean. Normal (non-handoff)
calls pass nothing → behavior is 100% unchanged.

## Event logging

Add `runnerType` plus handoff metadata (`handoff: { from, to, sessionId }`) to
the `logger.event(...)` payloads at `session_started` / `session_completed` /
`session_stopped` and the error path. Non-handoff sessions just get `runnerType`
added (harmless, useful).

## Testing (Vitest)

- **Command parsing**: valid `claude`/`codex`, optional mention, trailing text,
  unknown target, no-command.
- **Runner selection / force-override**: `buildIssueConfig` with
  `runnerTypeOverride` ignores sticky session id and labels.
- **Same-worktree reuse**: snapshot's `worktreePath`/`branch` equal the source
  session's; no new worktree is created.
- **Blocked handoff**: a runner that never stops within the timeout → blocked
  comment, no rebind.
- **Snapshot creation**: all fields populated from a fake `GitService`; PR and
  summary gracefully omitted when absent.
- **Failure handling**: target runner fails to start → error surfaced, session
  left coherent.
- **Regression guard**: `[agent=claude]` / `[agent=codex]` still start exactly
  one runner.

## Backward compatibility

- No config schema changes.
- `/handoff` is purely additive comment behavior.
- `runnerTypeOverride` is optional and defaults to today's path.
- Single-runner behavior is untouched.

## Acceptance criteria

- `[agent=claude]` and `[agent=codex]` still start exactly one runner.
- `@Cyrus /handoff codex` after a Claude run starts Codex in the same worktree.
- `@Cyrus /handoff claude` after a Codex run starts Claude in the same worktree.
- Cyrus never runs both runners concurrently in the same worktree.
- Both runners report back to the same Linear issue.
- Tests cover command parsing, runner selection, same-worktree reuse, blocked
  handoff, snapshot creation, and failure handling.
