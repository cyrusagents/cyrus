# Test Drive: scheduled repository tasks and Linear delegation

**Date**: 2026-09-23
**Goal**: Validate timed direct execution, normal issue workflow regression, and real Linear delegation.
**Test repo**: `/tmp/atmiko-automation-f1-20260923` (fresh F1 repository, no remote)

## Verification results

### Direct scheduled task

- [x] F1 initialized a fresh repository; server ping/status succeeded on port 3600.
- [x] Created a one-time direct automation through the local same-origin board API.
- [x] Scheduler dispatched once and created an isolated `AUTO-…` worktree from local `main`.
- [x] Real Claude runner executed without a Linear issue/connection.
- [x] Board entries included assistant, tool/action and result output with timestamps.
- [x] Final no-change record was persisted as `succeeded`; one-time schedule finished.
- [ ] Actual code-change → remote PR path: not exercised; this isolated repo has no remote.

Automation: `1f8832c6-c200-4c0d-b12b-6bfce4873465`.
Run: `9e10838c-9176-4222-ae2d-dd1624dce43d`.
Local session: `automation-9e10838c-9176-4222-ae2d-dd1624dce43d`.
Runner session: `1ad84560-db17-4661-adf1-ad9cba2bc706`.

### Existing issue workflow

- [x] `create-issue` returned `issue-1` / `DEF-1` with metadata.
- [x] `start-session` returned `session-1`.
- [x] Repository selection elicitation appeared; a prompt selecting `[repo=f1-test-repo]` resumed execution.
- [x] Worktree `DEF-1` created; real Claude completed the requested read-only receipt.
- [x] `view-session --limit 10 --offset 0` returned six coherent, timestamped activities,
  including elicitation, user prompt, routing/model thoughts and final response.
- [x] `stop-session --session-id session-1` succeeded; background F1 server stopped.
- [ ] Visual browser rendering/search: browser control denied local board navigation; not visually verified.

Commands used the canonical `skills/f1-test-drive/SKILL.md` protocol with `ATMIKO_PORT=3600`.
Expected environment warnings: the fresh repository has no `origin`, so GitService used local `main`;
the existing broad F1 tool permissions generated an SDK `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` warning.
Neither prevented completion. No unhandled application exception was observed.

### Real Linear workspace (user-authorized Nexmoe)

A temporary local scheduler used the connected Miko OAuth identity to schedule creation and delegation.
The existing live worker received the real webhook. Tasks explicitly requested a read-only receipt,
with no code inspection, edits, commits, pushes, PR creation or external messages.

1. [NEX-291](https://linear.app/nexmoe/issue/NEX-291/miko-test-scheduled-task-delegation-smoke-test)
   was created once with its durable UUID and delegated correctly. The live worker failed because the
   repository's existing Cursor model `cursor-grok-4.7-xhigh-fast` was rejected by that provider.
2. [NEX-292](https://linear.app/nexmoe/issue/NEX-292/miko-test-scheduled-delegation-validation-claude)
   added `[agent=claude]` and `[model=sonnet]` to the test instructions, leaving repository defaults unchanged.
   It progressed through `dispatching → waiting_session → running → succeeded`.
   The final response confirmed successful scheduled creation and delegation with a reasoned no-change record.

Second run: `911182e7-3275-400c-83eb-8f14fbe022b3`.
Linear agent session: `0b5458af-ad04-411f-8937-2d21af48ff4b`.
The external live worker used its installed version; this validates the new scheduler's creation,
delegation and reconciliation against real Linear, while local F1 exercises the changed runner entry point.
Both temporary schedulers were stopped; test issues remain clearly marked in Linear.

## Automated verification

- New automation tests: 33 passing across scheduler/storage/service, adapters/completion,
  local API guards and production lifecycle/standalone runner configuration.
- Full package suite passed (edge-worker: 969 passing, one skipped before the final two lifecycle tests;
  the final standalone-config and durable-webhook tests subsequently passed with all five lifecycle tests).
- Full `pnpm typecheck` and `pnpm build`: passed.
- `pnpm audit --registry=https://registry.npmjs.org`: no known vulnerabilities.
- Targeted Biome check and `git diff --check`: passed.
- Full `pnpm lint`: blocked by existing unrelated workspace lint issues (31 errors, 173 warnings),
  including modified `apps/web` files. Those changes were preserved.

## Retrospective

The timer, durable run identity, isolated worktree, real agent activity and no-change completion worked.
The real smoke test exposed the need to share the existing refresh-capable Linear client; the adapter now
does so. It also distinguished a provider model configuration failure from scheduling/delegation success.
Crash/retry/overlap and late-event behavior are covered by automated tests. Remote PR creation and visual
browser acceptance remain unverified in this drive and should be checked before release.

## Fluid Functionalism UI follow-up

Replaced the schedule UI with the official registry's Button, Badge, InputGroup,
Select, Switch, Tabs and Dialog components. Components, shared surface tokens and
Inter variable font are bundled locally. All scheduling endpoints remain unchanged.

The existing user-owned `http://localhost:3457/board` tab was accessible and refreshed
successfully, resolving the earlier visual-verification limitation for this page.
Verified the navigation, empty state and new-task dialog by screenshot, with no
browser console errors. No task was saved or executed during this visual check.
Browser-created localhost tabs still returned `ERR_BLOCKED_BY_CLIENT`.

New form tests cover weekly edit round-trips, once-only UTC instant preservation,
invalid dates/empty weekdays, and dropping inactive Linear fields. All four pass.
The full edge-worker suite passed: 87 files, 975 tests passed and one skipped. Workspace typecheck,
board build, targeted lint, frozen-lockfile install and zero-advisory audit passed.
Removed the redundant root PostCSS override; the owning UI build dependency now
resolves the patched version naturally and audit remains clean.
