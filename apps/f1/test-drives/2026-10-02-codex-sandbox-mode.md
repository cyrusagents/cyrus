# Codex sandbox-mode configuration

Date: 2026-10-02. Tested working tree based on `0536162`, containing the
`codexSandboxMode` runtime/schema changes submitted in draft #1521.

## Scope and setup

F1 is applicable because the change selects the actual Codex execution sandbox
for newly constructed issue/chat runners. Assertions: omitted mode denies a host
write; explicit full access allows it and native Chromium startup; read-only
also denies a worktree write; removing the field restores workspace writes while
continuing to deny host writes.

Fresh empty Git repository: `/tmp/cyrus-sandbox-mode-f1-1002`, local main at
`6f55a82`. Started `bun run apps/f1/server.ts` on port 3600 with
`CYRUS_DEFAULT_RUNNER=codex`, `CODEX_MODEL=gpt-6.1-sol`, and `CYRUS_REPO_PATH`
pointing at that repository. The successful server used F1's default disabled
egress proxy. Its temporary Cyrus home was `cyrus-f1-1790944974271` under the
OS temporary directory.

Temporary harness instrumentation wrote the generated config to that home and
called `edgeWorker.setConfigPath(configPath)`, allowing the existing production
config watcher to run. This instrumentation was reverted before submission.
The production Cyrus service was not restarted or reconfigured.

Used F1 JSON-RPC `ping`, `status`, `createIssue`, `startSession`, `promptSession`,
`viewSession`, and `stopSession`. Each issue used `[agent=codex]`; repository
selection was answered with `F1 Test Repository`. Probes exclusively created
fresh files and immediately removed successful writes; no permission escalation
or browser wrapper was used.

## Results

| Config at runner creation | Issue/session | Observed behavior | Final response |
| --- | --- | --- | --- |
| Omitted / workspace-write | DEF-1 / session-1 | Host write denied with `PermissionError: Operation not permitted` | activity-9 |
| danger-full-access | DEF-2 / session-2 | Host write allowed; raw Chrome open/title/screenshot/close all exited 0 | activity-26 |
| read-only | DEF-4 / session-4 | Host write and worktree write both denied with `PermissionError` | activity-44 |
| Removed after reload | DEF-5 / session-5 | Host write denied; worktree write allowed and deleted | activity-58 |

The host probe was `/Users/jappy/.cyrus-f1-mode-write-1002`. Read-only tried
`./readonly-write-probe.txt`; reset tried `./default-write-probe.txt`.

The full-access browser test invoked `/opt/homebrew/bin/agent-browser` directly,
with the unique named session `cyrus-f1-mode-full-1002` and the installed Google
Chrome executable on every command. Title was `Example Domain`; screenshot
`mode-chrome.png` was saved directly in DEF-2's worktree. The named session closed
successfully. No native command-rule exception or local helper was involved.

Config watcher logs confirmed changes before DEF-2, DEF-4, and DEF-5 started.
An initial DEF-3 read-only attempt started before the watcher reloaded and retained
full access, as expected for an existing runner. It is excluded from read-only
validation; the fresh DEF-4 session above used the reloaded setting.

Issue creation, repository routing, worktree creation, timestamped readable
`thought`/`action`/`response` activities, and final response posting all completed.
All five sessions stopped successfully and the isolated server was terminated.
No probe file remained in the host home. Full RPC evidence remains locally in
`/tmp/cyrus-f1-mode-*-activities.json`.

## Checks and limits

- 77 targeted tests passed: core schema (4), CLI config forwarding (7),
  EdgeWorker config reload/runner selection (41), Codex policy/backend (25).
- `pnpm build`, `pnpm typecheck`, and changed-file Biome checks passed.
- An initial F1 run with `CYRUS_SANDBOX=1` failed before model execution with
  `failed to load workspace requirements`. Successful drives therefore do not
  establish egress-enabled/profile execution. Unit tests cover explicit native
  mode precedence with restrictive generated settings; the workspace-write
  profile remains unchanged.
- DEF-1 reused the earlier failed run's worktree; subsequent issues created fresh
  worktrees. The empty repository had no origin, so expected fetch warnings fell
  back to local main.
- Chat sessions use the same tested runner factory but were not separately driven
  end-to-end. Brave, other platforms, and cloud execution were not driven for
  this revision. Earlier browser-host and native-rule evidence is historical,
  recorded separately in the local-browser investigation.
- Installed local wrappers, actual operator configuration, and live Cyrus service
  permissions were left unchanged. Full access was enabled only in F1's temporary
  configuration.
