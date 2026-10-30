# F1 drive: Jira remote-agent task bridge (runtime side)

Date: 2026-10-30, 17:34–17:37 UTC.
Base: `fa5bb90e3` plus the runtime code-review corrections (uncommitted working tree at drive time; same content as the commit that updates this file).

## Applicability and scenario

The change adds and corrects runtime routes that create isolated worktrees and start/continue/stop runner sessions, so F1 is required. The stock F1 server (`apps/f1/server.ts`, real `EdgeWorker` in CLI mode, repository `f1-test-repo`) ran with a throwaway `CYRUS_API_KEY` on `127.0.0.1:3621` (Claude, default runner) and `3622` (`CYRUS_DEFAULT_RUNNER=codex`). Ports were checked free first; 54322 was not touched. The bridge was driven with `curl` using bridge v1 bodies, as Cyrus Hosted would. Claude used the machine's existing local Claude Code login; model `sonnet`, fallback `haiku` from defaults. No Jira, Forge or Hosted service was involved.

The fixture repo (`./f1 init-test-repo -p /tmp/jira-f1-v3-repo`) got one extra commit: a tracked `.mcp.json` declaring an HTTP server `repo-sentinel` with a sentinel bearer header (not a real credential), to prove a Jira task does not load repository MCP config.

## Commands and results

- Server log: `✅ Jira agent task routes registered`. `get` without a key → 401.
- `send` create task A (context `1111…`, issue `QA-1` "Add a VERSION constant") → 200 `submitted`, `admitted: true`. Follow-up `f-1` ("Also add a one-line comment…") while A worked → 200 `working`, `pendingFollowups: 1`. Exact retry of the create → 200, same task, no second runner.
- Poll `get` → `completed`, `settled: true`, 2 progress lines; result: "Added a one-line comment above the constant and committed (`f18bf09`)…". The follow-up ran as the next turn resuming the same Claude session (`session_resumed`, same `claudeSessionId`). Worktree `…/worktrees/jira-11111111-1111-4111-8111-111111111111` on branch `cyrus/jira-qa-1-11111111-1111-4111-8111-111111111111` (full context UUID) holds two commits; fixture `main` unchanged.
- MCP: the server log has 3 `claude_query_options` events for the Jira sessions and **0** `mcpServerNames` entries; `repo-sentinel` never appears. `strictMcpConfig: true`. The runner env shows `CYRUS_API_KEY` blanked.
- `send` create task B in the now-settled context (long test-writing request) → 200. After ~12 s `cancel` B: log `session_stop_requested` 17:36:09.070, `Session was stopped, breaking from query loop` 17:36:09.194, `session_completed` 17:36:11.072; the cancel response came back after that with `canceled`, `settled: true`. Follow-up to B → 409 `task_terminal`.
- Pre-admission tombstone: `cancel` of never-seen task C → 200 `canceled`, `settled: true`, `admitted: false`, "Canceled before Cyrus started it."; then `send` create C → 409 `task_canceled` (no runner). Tombstone cancel for another task with a different account binding → 409 `context_mismatch`.
- Non-Claude runner (port 3622, `CYRUS_DEFAULT_RUNNER=codex`): create → 400 `unsupported_runner` with the guidance message; no session started.
- Both servers were stopped by killing their recorded PIDs; ports closed.

Server logs: `logs/runtime-f1-claude-server.log` (debug level; ambient environment values redacted after the run) and `logs/runtime-f1-codex-server.log` in the task-run directory.

## Joined Hosted ⇄ runtime drive (17:40–17:46 UTC)

Real Cyrus Hosted A2A service, runtime bridge HTTP client and dispatch ledger (real migration on PGlite) against this F1 server with real Claude. Only Forge/Jira were simulated (Forge token verification is unit-tested in Hosted; the as-user Jira API was a fake). New opt-in F1 server variables: `CYRUS_F1_REPO_ID` (bind the fixture to a Hosted repository UUID) and `CYRUS_F1_HOME` (keep one Cyrus home across restarts). Port 3631 checked free first; throwaway `CYRUS_API_KEY`; info log level. Harness: Hosted `apps/app/src/lib/jira-agent/joined-runtime.test.ts`.

- Assignment (SendMessage, no context) → `SUBMITTED`; same message re-sent with a new JSON-RPC id → same task, one runner. GetTask polling → `COMPLETED` with an artifact naming commit `96cda69` (`Add JOINED.md`).
- Follow-up in the completed context → a NEW task in the SAME context, resumed the session → `COMPLETED`, commit `067af41`; the first task stayed `COMPLETED`. Worktree `jira-9f0f7d74-…` (full UUID) holds both commits; fixture `main` unchanged. 0 `mcpServerNames` entries in the server log.
- Long task, CancelTask after 10 s → `CANCELED` (runtime log: `session_stop_requested` 17:41:21.623 → `session_completed` 17:41:23.627 before the reply). CancelTask on the completed task → `TASK_NOT_CANCELABLE`.
- **Restart:** a long task was running (GetTask `WORKING`) when the server was killed with `SIGKILL`. Its Claude Code child (pid recorded) **survived** the parent kill and was still running in the context's worktree 50 s later — confirming the review concern. Restarting on the same `CYRUS_F1_HOME` logged `Stopped 1 orphaned process(es) in closed Jira worktrees`; the orphan was gone. Hosted GetTask → `FAILED` "Cyrus restarted while this task was running…"; a follow-up in that context → runtime `context_closed` → Hosted `FAILED` with restart guidance; a fresh assignment (new context) → `COMPLETED`.

Logs (task-run dir `joined/`): `f1-server-1.log`, `f1-server-2.log`, `joined-main.log`, `joined-restart-before.log`, `joined-restart-after.log`, `children-after-kill.txt`.

## Limits

- Restart closure and orphan reconciliation were driven for real in the joined drive above (`CYRUS_F1_HOME`). Corrupt-journal quarantine, journal-write failure during cancel/deadline, and the queued-for-slot cancel are proven by unit tests (`JiraAgentTaskService.review.test.ts`, `RunnerConcurrency.test.ts`), not by F1.
- The egress sandbox was off (`hasSandbox: false`); sandbox preservation is covered by `RunnerConfigBuilder.jira-scope.test.ts`.
- Only Cyrus-owned integration variables are blanked; the operator's other ambient environment variables still reach the session, as for every Cyrus session type.
- No Jira/Forge delivery, Hosted dispatch ledger or real push/PR was exercised (fixture has no remote).
