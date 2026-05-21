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
- [ ] Real OpenCode CLI runtime-extension loading remains unvalidated in F1 because this F1 server cannot inject `opencode.config`, and the real OpenCode-selected smoke exited with `Session not found` before the prompt ran.

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

The current F1 server hardcodes its `EdgeWorkerConfig` in `apps/f1/server.ts` and has no environment/config-file injection point for `opencode.config`. To avoid expanding Task 5 scope, the runtime-extension check used the closest available validation: direct `OpenCodeRunner` launch with a fake OpenCode executable that reads `OPENCODE_CONFIG_CONTENT` and executes the configured local extension command. This proves Cyrus passes the merged OpenCode config and environment to the launched process, and that the launched process can consume the configured `mcp` entry. It does not prove the real OpenCode CLI successfully loads or invokes that MCP server.

Temporary probe files:

- `/var/folders/_r/fld8l71j7ts635hlb5vtgnb80000gn/T/opencode/ng71-mcp/fake-opencode.mjs`
- `/var/folders/_r/fld8l71j7ts635hlb5vtgnb80000gn/T/opencode/ng71-mcp/local-extension.mjs`
- `/var/folders/_r/fld8l71j7ts635hlb5vtgnb80000gn/T/opencode/ng71-mcp/probe.mjs` (the exact passing rerun used the inline `node --input-type=module` command below instead of this temp file)

Reproducible setup used for the probe:

```bash
mkdir -p "/var/folders/_r/fld8l71j7ts635hlb5vtgnb80000gn/T/opencode/ng71-mcp"
```

Create the two executable files below at the listed paths, then run the `chmod` and inline `node --input-type=module` commands in this section from the repository root.

`fake-opencode.mjs`:

```javascript
#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || "{}");
const server = config.mcp?.["ng71-local-extension"];

if (!server || server.type !== "local" || !Array.isArray(server.command)) {
  console.error("missing ng71-local-extension MCP config");
  process.exit(2);
}

const [command, ...args] = server.command;
const child = spawnSync(command, args, {
  env: { ...process.env, ...(server.environment || {}) },
  encoding: "utf8",
});

if (child.status !== 0) {
  console.error(child.stderr || child.stdout || `MCP exited ${child.status}`);
  process.exit(child.status || 3);
}

const output = (child.stdout || "").trim();
if (output !== "NG71_MCP_EXTENSION_OK") {
  console.error(`unexpected MCP output: ${output}`);
  process.exit(4);
}

const sessionID = "ng71-opencode-config-probe";
console.log(JSON.stringify({ type: "step_start", sessionID }));
console.log(
  JSON.stringify({
    type: "tool_use",
    part: {
      callID: "tool-ng71",
      tool: "mcp_ng71-local-extension_probe",
      state: { status: "running", input: {} },
    },
  }),
);
console.log(
  JSON.stringify({
    type: "tool_use",
    part: {
      callID: "tool-ng71",
      tool: "mcp_ng71-local-extension_probe",
      state: { status: "completed", output },
    },
  }),
);
console.log(
  JSON.stringify({
    type: "text",
    part: { text: `Runtime extension returned ${output}` },
  }),
);
console.log(
  JSON.stringify({
    type: "step_finish",
    sessionID,
    result: "NG71_OPENCODE_CONFIG_OVERRIDE_OK",
    cost: 0,
    usage: { inputTokens: 1, outputTokens: 1 },
  }),
);
```

`local-extension.mjs`:

```javascript
#!/usr/bin/env node
if (process.env.NG71_EXTENSION_TOKEN !== "configured-through-opencode-config") {
  console.error("missing configured extension environment");
  process.exit(1);
}

console.log("NG71_MCP_EXTENSION_OK");
```

```bash
chmod +x "/var/folders/_r/fld8l71j7ts635hlb5vtgnb80000gn/T/opencode/ng71-mcp/fake-opencode.mjs" "/var/folders/_r/fld8l71j7ts635hlb5vtgnb80000gn/T/opencode/ng71-mcp/local-extension.mjs"
node "/var/folders/_r/fld8l71j7ts635hlb5vtgnb80000gn/T/opencode/ng71-mcp/probe.mjs"
```

First result: FAIL. The fake event shape did not match `OpenCodeRunner`'s expected `tool_use.part.state` schema, so runner messages did not include the extension output.

After correcting the temporary fake event shape:

```bash
node --input-type=module -e 'import { mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path"; import { OpenCodeRunner } from "./packages/opencode-runner/dist/index.js"; const root = "/var/folders/_r/fld8l71j7ts635hlb5vtgnb80000gn/T/opencode/ng71-mcp"; const runner = new OpenCodeRunner({ openCodePath: join(root, "fake-opencode.mjs"), workingDirectory: mkdtempSync(join(tmpdir(), "ng71-opencode-evidence-workspace-")), cyrusHome: mkdtempSync(join(tmpdir(), "ng71-opencode-evidence-home-")), title: "NG-71 OpenCode config override evidence", allowedTools: ["Read(**)", "mcp__linear__get_issue"], opencodeRepositoryConfig: { mcp: { "ng71-local-extension": { type: "local", command: ["node", join(root, "local-extension.mjs")], environment: { NG71_EXTENSION_TOKEN: "configured-through-opencode-config" }, enabled: true } } } }); await runner.start("Use the configured local MCP extension."); const serialized = JSON.stringify(runner.getMessages()); console.log(`extensionOutput=${serialized.includes("NG71_MCP_EXTENSION_OK")}`); console.log(`finalSentinel=${serialized.includes("NG71_OPENCODE_CONFIG_OVERRIDE_OK")}`); console.log(serialized.match(/NG71_MCP_EXTENSION_OK/)?.[0] || "missing-extension-output"); console.log(`messages=${runner.getMessages().length}`);'
```

```text
extensionOutput=true
finalSentinel=true
NG71_MCP_EXTENSION_OK
messages=5
```

Earlier output from the shorter probe command was:

```text
NG71_OPENCODE_CONFIG_OVERRIDE_OK
messages=5
```

Result: PASS. The exact evidence command above confirms `OpenCodeRunner` passed the configured `opencodeRepositoryConfig.mcp` data into `OPENCODE_CONFIG_CONTENT`, passed the configured MCP environment through that fake OpenCode process, and captured the fake process's `NG71_MCP_EXTENSION_OK` output in runner messages. This is a config propagation probe, not proof that real OpenCode loaded or invoked the MCP server.

## Final Retrospective

NG-71 unit, package, and type verification passed. F1 validated issue creation, repository selection, worktree creation, renderer activity quality, pagination, and OpenCode runner selection.

The implemented NG-71 product decision is the explicit Cyrus-managed OpenCode config path: users copy selected OpenCode-native config into global or repository `opencode.config`, while Cyrus-generated MCP and permission rules remain authoritative. This avoids implicitly inheriting the user's entire global OpenCode plugin/config surface into agent sessions.

The full F1 runtime-extension validation could not be performed without modifying F1 because `apps/f1/server.ts` does not provide a way to inject `opencode.config` into the hardcoded `EdgeWorkerConfig`. Real OpenCode execution also failed with `Session not found` after runner selection. Within NG-71 scope, the closest deterministic validation passed by launching `OpenCodeRunner` with a fake OpenCode process and verifying Cyrus propagated the configured MCP entry and environment to that process. A future F1 enhancement should add an `opencode.config` injection point if we want automated real-CLI validation for configured OpenCode plugins or MCP servers.
