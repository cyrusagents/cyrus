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

> **Restart cleanup changed after these drives.** The drives below that report `Stopped … process(es)` ran builds that signalled recorded processes at startup. That signalling was removed (review 3: a pid can be reused between any check and `kill`), so restart reconciliation is now **report-only** — it logs recorded identities that may still be running and signals nothing. The report-only behavior is covered by `test/OrphanReaper.test.ts` (real `sleep` fixtures: own process recorded and reported, nothing signalled; unrelated process in the worktree untouched); it has **not** been re-driven in F1.

## Joined Hosted ⇄ runtime drive (17:40–17:46 UTC)

Real Cyrus Hosted A2A service, runtime bridge HTTP client and dispatch ledger (real migration on PGlite) against this F1 server with real Claude. Only Forge/Jira were simulated (Forge token verification is unit-tested in Hosted; the as-user Jira API was a fake). New opt-in F1 server variables: `CYRUS_F1_REPO_ID` (bind the fixture to a Hosted repository UUID) and `CYRUS_F1_HOME` (keep one Cyrus home across restarts). Port 3631 checked free first; throwaway `CYRUS_API_KEY`; info log level. Harness: Hosted `apps/app/src/lib/jira-agent/joined-runtime.test.ts`.

- Assignment (SendMessage, no context) → `SUBMITTED`; same message re-sent with a new JSON-RPC id → same task, one runner. GetTask polling → `COMPLETED` with an artifact naming commit `96cda69` (`Add JOINED.md`).
- Follow-up in the completed context → a NEW task in the SAME context, resumed the session → `COMPLETED`, commit `067af41`; the first task stayed `COMPLETED`. Worktree `jira-9f0f7d74-…` (full UUID) holds both commits; fixture `main` unchanged. 0 `mcpServerNames` entries in the server log.
- Long task, CancelTask after 10 s → `CANCELED` (runtime log: `session_stop_requested` 17:41:21.623 → `session_completed` 17:41:23.627 before the reply). CancelTask on the completed task → `TASK_NOT_CANCELABLE`.
- **Restart:** a long task was running (GetTask `WORKING`) when the server was killed with `SIGKILL`. Its Claude Code child (pid recorded) **survived** the parent kill and was still running in the context's worktree 50 s later — confirming the review concern. Restarting on the same `CYRUS_F1_HOME` logged `Stopped 1 orphaned process(es) in closed Jira worktrees`; the orphan was gone. (That build matched ANY process by working directory; it was superseded by the ownership-scoped cleanup driven below.) Hosted GetTask → `FAILED` "Cyrus restarted while this task was running…"; a follow-up in that context → runtime `context_closed` → Hosted `FAILED` with restart guidance; a fresh assignment (new context) → `COMPLETED`.

Logs (task-run dir `joined/`): `f1-server-1.log`, `f1-server-2.log`, `joined-main.log`, `joined-restart-before.log`, `joined-restart-after.log`, `children-after-kill.txt`.

## Ownership-scoped restart drive (runtime only, 17:53–17:56 UTC)

Separate from the joined drive above: curl bridge v1 bodies against the F1 server (no Hosted), real Claude, port 3641 checked free, throwaway key, `CYRUS_F1_HOME=/tmp/jira-f1-r3-home`, `CYRUS_F1_REPO_ID` = a random UUID. Evidence: task-run dir `joined/r3/`.

- Create (context `57865b4e-…`) → 200 `submitted`. While it worked, the journal recorded `ownedProcesses: [{pid: 41852, started: "Fri Oct 30 10:54:28 2026"}]` — the Claude Code child, a descendant of the server with cwd in the task worktree.
- An unrelated `sleep 600` (pid 42392, parent 1, i.e. not started by Cyrus) was started with cwd inside the same worktree, standing in for a user's shell job.
- Server (pid 41264) `SIGKILL`ed at 17:54:58Z; 5 s later both 41852 and 42392 were still alive (`after-kill.txt`).
- Restart on the same home: `Stopped 1 of 1 process(es) this runtime had started in a closed Jira worktree`; 41852 gone, **42392 untouched** (`after-restart.txt`; it was then killed manually).
- `get` → `failed`, settled, restart message; `create` of a new task in that context → 409 `context_closed`.

Limits of this drive: macOS only (Linux uses `/proc` paths covered only by code review); one owned process; ownership is (pid, start time to the second) captured on runner messages (throttled to 10 s), so a process spawned and orphaned between captures would not be recorded and is left running.

## Final joined drive at runtime `a33b2ddef` / Hosted `ec06f5ec5` (18:01–18:05 UTC)

Same harness and simulation boundaries as the first joined drive (Hosted service + bridge + ledger on PGlite; Forge/Jira simulated), F1 port 3651 checked free, throwaway key, `CYRUS_F1_HOME=/tmp/jira-final-home`. Evidence: task-run dir `joined/final/` (`joined-main.log`, `joined-restart-before.log`, `joined-restart-after.log`, `f1-server-1.log`, `f1-server-2.log`, `children.txt`).

- Main phase (exit 0): assignment → `COMPLETED` (commit `6bb7d4b`); duplicate message → same task; follow-up → new task, same context, `COMPLETED` (commit `b80ce3b`); cancel of a running task → `CANCELED`; cancel of a completed task → `TASK_NOT_CANCELABLE`.
- Restart phases (exit 0): runtime `SIGKILL`ed while a task was `WORKING`; on restart that build logged `Stopped 1 of 1 process(es) this runtime had started…` for the journal-recorded pid 55613 (signalling since removed, see note above). Hosted GetTask → `FAILED` with the restart message; follow-up in that context → `FAILED` (`context_closed`); fresh assignment → `COMPLETED`. The operator's own post-kill liveness check in this run was invalid (a shell word-splitting bug), so child survival is not claimed from this run.

## Report-only restart drive at `b6fda3b88` (+ test-only deadline fix), 20:02–20:05 UTC

Bounded drive of the changed restart path only (runtime, curl bridge v1 bodies; no Hosted). F1 port 3661 checked free; the only other listener (an unrelated node process on 3123) was left alone. Real Claude, throwaway key, `CYRUS_F1_HOME=/tmp/jira-r8-home`, `CYRUS_F1_REPO_ID` = random UUID. Evidence: task-run dir `joined/r8/` (`f1-server-1.log`, `f1-server-2.log`, `identities.txt`, `after-kill.txt`, `after-restart.txt`, `get-resp.json`, `create2-resp.json`, `cleanup.txt`).

- Create → 200 `submitted`, `admitted: true`. The journal recorded `ownedProcesses: [{pid 50056, started "Fri Oct 30 13:03:09 2026"}]` (the Claude Code child; parent = server 49727), task `working`.
- An unrelated helper `sleep 900` (pid 50453, parent 1, started 13:03:19, cwd inside the same worktree) was started outside Cyrus.
- Server `SIGKILL`ed. 4 s later both 50056 and 50453 were alive with unchanged start times.
- Restart on the same home logged: `A Jira task interrupted by the restart may have left processes running in …: pid 50056 (started Fri Oct 30 13:03:09 2026) still present. They were not stopped automatically; … The conversation stays closed.` Both processes were still alive with unchanged start times right after startup and 20 s later — nothing was signalled.
- `get` → `failed`, `settled: true`, restart message. `send create` of a new task in that context → 409 `context_closed`. Journal `closed: true`, single task `failed`/settled. No new session started in the restarted server log.
- Cleanup (operator, not Cyrus): the restarted server, the helper and the orphaned Claude child were sent SIGTERM after re-checking each pid's start time; all three exited, port 3661 released.

## Limits

- Restart closure was driven for real in the joined drives above (`CYRUS_F1_HOME`). The current report-only restart handling was driven once, in the bounded runtime-only F1 slice at `b6fda3b88` above (one real Claude child, macOS, curl bridge bodies, no Hosted); the earlier automatic-termination drives are historical. Corrupt-journal quarantine, journal-write failure during cancel/deadline, and the queued-for-slot cancel are proven by unit tests (`JiraAgentTaskService.review.test.ts`, `RunnerConcurrency.test.ts`), not by F1.
- The egress sandbox was off (`hasSandbox: false`); sandbox preservation is covered by `RunnerConfigBuilder.jira-scope.test.ts`.
- Only Cyrus-owned integration variables are blanked; the operator's other ambient environment variables still reach the session, as for every Cyrus session type.
- The Hosted A2A service, runtime bridge client and dispatch ledger ran only locally in the joined drives (real migration on PGlite, in-process). No deployed Hosted, Supabase/PostgREST, Forge/Jira delivery, real invocation token or user token, and no real push/PR (the fixture has no remote) was exercised.
