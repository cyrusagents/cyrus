# F1 drive: Jira remote-agent task bridge (runtime side)

Date: 2026-10-30, 17:08–17:11 UTC.
Base: `c4a2c2d6676bedee88f2d7bd097fa462a15be83d` (branch `codex/jira-agent-runtime`, uncommitted working tree at drive time; same content as the commit that adds this file).

## Applicability and scenario

This adds runtime routes that create isolated worktrees and start/continue/stop runner sessions, so F1 is required. The stock F1 server (`apps/f1/server.ts`, real `EdgeWorker` in CLI mode, repository `f1-test-repo`) was started with a throwaway `CYRUS_API_KEY` on `127.0.0.1:3611` (and `3612` for a re-check after narrowing tools). Ports were checked free first; 54322 was not touched. The bridge was driven with `curl` exactly as Cyrus Hosted would, using bridge v1 bodies. Claude used the machine's existing local Claude Code login; model `sonnet`, fallback `haiku` from defaults (not hardcoded by this change). No Jira, Forge or Hosted service was involved.

## Commands and results

- `./f1 init-test-repo -p /tmp/jira-f1-repo`: local fixture repo, no origin.
- `CYRUS_PORT=3611 CYRUS_REPO_PATH=/tmp/jira-f1-repo bun run server.ts`: log shows `✅ Jira agent task routes registered`.
- `POST /api/jira-agent/v1/tasks/get` with wrong key → 401 `unauthorized`; with no header → 401; correct key + unknown task → 404 `task_not_found`.
- `send` create (task A, context 1111…, message `msg-1`, issue `QA-1` "Add a VERSION constant") → 200 `submitted`. Exact retry → same snapshot, no second runner. Create with a different task id (B) in the same context while A runs → 409 `context_busy`.
- `send` followup `f-1` ("Also add a one-line comment above the constant.") while A was working → 200 `working`, `pendingFollowups: 1`.
- Poll `get` → `completed`, `settled: true`, two progress lines (one per turn) and the follow-up's answer as `result`. The follow-up was delivered into the same Claude session (`5e5589f2…`) at the turn boundary; `session_completed` logged after the second result.
- Worktree `…/worktrees/jira-111111111111` on branch `cyrus/jira-qa-1-11111111` holds two new commits (VERSION constant, then the comment); the fixture repo's `main` is unchanged. Journal `…/jira-agent/contexts/11111111-….json` and per-context memory dir `…/jira-agent/memory/11111111-…` exist.
- `send` create task B in the same (now settled) context → `session_resumed` with `resumeSessionId 5e5589f2…` in the same worktree. After ~12 s `cancel` → log `session_stop_requested`, `Session was stopped, breaking from query loop`, `session_completed`; response `canceled`, `settled: true`, no result. A follow-up to B afterwards → 409 `task_terminal`. `cancel` of completed task A → returns A unchanged (`completed`). `/status` back to `idle`.
- Runner options logged for the Jira session: `strictMcpConfig`, no MCP servers, `allowedDirectories` = worktree + its git metadata dirs, auto-memory directory per context, no AskUserQuestion. After narrowing (re-check on 3612, task C, read-only question → `completed`), the allowed tools no longer include `EnterWorktree`, `ExitWorktree`, `Cron*`, `ScheduleWakeup`, `RemoteTrigger`, `PushNotification` or any `mcp__*`.
- Both servers were stopped by killing the verified listener PIDs; ports closed.

## Limits

- F1 creates a fresh `CYRUS_HOME` per start, so restart recovery (in-flight task → `failed` with the restart message) was verified by unit tests on a shared journal, not by F1.
- The egress sandbox was not enabled in F1 (`hasSandbox: false`); sandbox preservation is covered by `RunnerConfigBuilder.jira-scope.test.ts`.
- The runner process inherits the operator's environment like every existing Cyrus session type; this change does not scrub ambient environment variables.
- No Jira/Forge delivery, Hosted dispatch ledger or real push/PR was exercised (fixture has no remote).
