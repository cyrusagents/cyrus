# Test Drive: NG-71 OpenCode Config Overrides

**Date**: 2026-05-20
**Goal**: Validate NG-71 OpenCode runtime config overrides, including access to an explicitly configured runtime extension.
**Test Repo**: `/var/folders/_r/fld8l71j7ts635hlb5vtgnb80000gn/T/opencode/ng71-f1/repo`

## Verification Results

### Unit And Type Verification
- [x] `pnpm --filter cyrus-core test:run` passed: 10 files, 131 tests.
- [x] `pnpm --filter cyrus-opencode-runner test:run` passed: 3 files, 15 tests.
- [x] `pnpm --filter cyrus-edge-worker test:run` passed: 56 files, 640 passed, 1 skipped.
- [x] `pnpm typecheck` passed across 17 workspace projects.
- [x] `pnpm test:packages:run` passed; output was truncated by OpenCode, with full output stored at `/Users/jappy/.local/share/opencode/tool-output/tool_e463f0458001BXB70qZlhmsRGZ`.

### F1 Issue Tracker
- [x] F1 test repository created.
- [x] F1 server started and health checks passed.
- [x] Issue created with ID `issue-1` / identifier `DEF-1`.
- [x] Session created with ID `session-1`.
- [x] Repository-selection elicitation appeared and was answered.

### F1 EdgeWorker And Renderer
- [x] Worktree was created at `/var/folders/_r/fld8l71j7ts635hlb5vtgnb80000gn/T/cyrus-f1-1779295065599/worktrees/DEF-1`.
- [x] Activity timeline showed coherent elicitation, prompt, thought, error, and response activities.
- [x] Pagination command returned the expected timeline view.
- [x] Runner selection reached OpenCode, shown by the activity `Using model: opencode`.
- [ ] Full real OpenCode execution did not complete; OpenCode exited with `Session not found` before the task prompt ran.

### OpenCode Runtime Extension Probe
- [x] Closest scoped validation passed using `OpenCodeRunner` with a deterministic local MCP-like extension configured through `opencodeRepositoryConfig.mcp`.
- [x] The launched OpenCode process received `OPENCODE_CONFIG_CONTENT`, found `mcp.ng71-local-extension`, executed its configured local command, and returned `NG71_MCP_EXTENSION_OK`.
- [x] Runner messages included final sentinel `NG71_OPENCODE_CONFIG_OVERRIDE_OK`.

## Session Log

### Required Verification Commands

```bash
pnpm --filter cyrus-core test:run
```

Result: PASS. `Test Files 10 passed (10)`, `Tests 131 passed (131)`.

```bash
pnpm --filter cyrus-opencode-runner test:run
```

Result: PASS. `Test Files 3 passed (3)`, `Tests 15 passed (15)`.

```bash
pnpm --filter cyrus-edge-worker test:run
```

Result: PASS. `Test Files 56 passed (56)`, `Tests 640 passed | 1 skipped (641)`.

```bash
pnpm typecheck
```

Result: PASS. All 17 scoped workspace projects completed `tsc --noEmit`.

```bash
pnpm test:packages:run
```

Result: PASS. Output was truncated by OpenCode; visible tail showed package suites completing, including `packages/edge-worker` with `56 passed (56)` and `640 passed | 1 skipped (641)`. Full output was saved at `/Users/jappy/.local/share/opencode/tool-output/tool_e463f0458001BXB70qZlhmsRGZ`.

### F1 Commands

```bash
./f1 init-test-repo --path "/var/folders/_r/fld8l71j7ts635hlb5vtgnb80000gn/T/opencode/ng71-f1/repo"
```

Result: PASS. Test repository created and initial commit made.

```bash
CYRUS_PORT=3600 CYRUS_REPO_PATH="/var/folders/_r/fld8l71j7ts635hlb5vtgnb80000gn/T/opencode/ng71-f1/repo" bun run server.ts > "/var/folders/_r/fld8l71j7ts635hlb5vtgnb80000gn/T/opencode/ng71-f1/server.log" 2>&1 &
```

Result: PASS. Server process started as PID `18662`.

```bash
CYRUS_PORT=3600 ./f1 ping
CYRUS_PORT=3600 ./f1 status
```

Result: PASS. Ping reported `Server is healthy`; status reported `ready`.

```bash
CYRUS_PORT=3600 ./f1 create-issue --title "NG-71 OpenCode runner selection smoke" --description "Validate that F1 can launch a Cyrus OpenCode runner session. Respond briefly with NG71_F1_OPENCODE_OK and do not modify files.\n\n[agent=opencode]"
```

Result: PASS. Issue created as `issue-1` / `DEF-1`.

```bash
CYRUS_PORT=3600 ./f1 start-session --issue-id issue-1
```

Result: PASS. Session created as `session-1`; it first posted repository-selection elicitation.

```bash
CYRUS_PORT=3600 ./f1 prompt-session --session-id session-1 --message "F1 Test Repository"
```

Result: PASS. Repository selected; EdgeWorker created a worktree and selected OpenCode.

```bash
CYRUS_PORT=3600 ./f1 view-session --session-id session-1
```

Result: PARTIAL. Timeline showed 6 activities, including `Using model: opencode`, then error `OpenCode exited with code 1: Error: Session not found`.

Relevant server log excerpt:

```text
[GitService] Creating git worktree at /var/folders/_r/fld8l71j7ts635hlb5vtgnb80000gn/T/cyrus-f1-1779295065599/worktrees/DEF-1 from local main
[EdgeWorker] Starting agent session for issue DEF-1
[OpenCodeRunner] Unsupported config entry skipped: permission:SendMessage: Unsupported Cyrus tool pattern for OpenCode
error: OpenCode exited with code 1: Error: Session not found
```

```bash
CYRUS_PORT=3600 ./f1 stop-session --session-id session-1
CYRUS_PORT=3600 ./f1 view-session --session-id session-1 --limit 10 --offset 0
```

Result: PASS. Session stopped and pagination returned 7 coherent activities with final status `complete`.

### Runtime Extension Probe Commands

The current F1 server hardcodes its `EdgeWorkerConfig` in `apps/f1/server.ts` and has no environment/config-file injection point for `opencode.config`. To avoid expanding Task 5 scope, the runtime-extension check used the closest available validation: direct `OpenCodeRunner` launch with a fake OpenCode executable that reads `OPENCODE_CONFIG_CONTENT` and executes the configured local extension command.

Temporary probe files:

- `/var/folders/_r/fld8l71j7ts635hlb5vtgnb80000gn/T/opencode/ng71-mcp/fake-opencode.mjs`
- `/var/folders/_r/fld8l71j7ts635hlb5vtgnb80000gn/T/opencode/ng71-mcp/local-extension.mjs`
- `/var/folders/_r/fld8l71j7ts635hlb5vtgnb80000gn/T/opencode/ng71-mcp/probe.mjs`

```bash
chmod +x "/var/folders/_r/fld8l71j7ts635hlb5vtgnb80000gn/T/opencode/ng71-mcp/fake-opencode.mjs" "/var/folders/_r/fld8l71j7ts635hlb5vtgnb80000gn/T/opencode/ng71-mcp/local-extension.mjs"
node "/var/folders/_r/fld8l71j7ts635hlb5vtgnb80000gn/T/opencode/ng71-mcp/probe.mjs"
```

First result: FAIL. The fake event shape did not match `OpenCodeRunner`'s expected `tool_use.part.state` schema, so runner messages did not include the extension output.

After correcting the temporary fake event shape:

```text
NG71_OPENCODE_CONFIG_OVERRIDE_OK
messages=5
```

Result: PASS. The configured local extension was available through `opencodeRepositoryConfig.mcp` to the Cyrus-launched OpenCode process.

## Final Retrospective

NG-71 unit, package, and type verification passed. F1 validated issue creation, repository selection, worktree creation, renderer activity quality, pagination, and OpenCode runner selection.

The full F1 runtime-extension validation could not be performed without modifying F1 because `apps/f1/server.ts` does not provide a way to inject `opencode.config` into the hardcoded `EdgeWorkerConfig`. Real OpenCode execution also failed with `Session not found` after runner selection. Within Task 5 scope, the closest deterministic validation passed by launching `OpenCodeRunner` with a configured local MCP extension and verifying the launched OpenCode process could read and execute that configured extension.
