# CYPACK-1657: Anthropic SDK 0.3.331 runtime verification

**Date:** 2026-11-24

**Goal:** Verify that Cyrus runs Claude Agent SDK 0.3.331 / Claude Code 2.1.331 through its issue, worktree, tool, and activity pipeline.

**Test repository:** `/private/tmp/f1-cypack-1657-final.v8n6r4/repo`

**Tested source:** `bf9751f936100dfd837ba68cffc9db463c9ac53d`

## Scenario

F1 created a disposable repository and routed an inspection-only issue through the real `ClaudeRunner` query path. The prompt required `Read(package.json)`, a foreground `Bash(pwd)` call with timeout `10000`, and the exact final marker `SDK_RUNTIME_OK`, without modifying files.

## Verification results

### Issue tracker

- [x] Health and ready status returned successfully.
- [x] `issue-1` / `DEF-1` was created and exposed through the CLI tracker.
- [x] Repository selection accepted `F1 Test Repository` and resumed the pending session.

### EdgeWorker and Claude runtime

- [x] Installed packages resolved to `@anthropic-ai/claude-agent-sdk` 0.3.331 and `@anthropic-ai/sdk` 1.13.0.
- [x] The bundled native executable reported Claude Code 2.1.331.
- [x] EdgeWorker created the `DEF-1` worktree from local `main`.
- [x] Cyrus supplied its 33-tool engineering catalog, including the three MCP resource-discovery tools.
- [x] Claude read `package.json`, ran foreground `Bash(pwd)`, and returned exactly `SDK_RUNTIME_OK`.
- [x] The session completed successfully without `session_writes_lost` or an unhandled error.

### Activity rendering

- [x] Elicitation, prompt, acknowledgment, routing, model, action, and response activities rendered coherently.
- [x] Pagination returned the requested three-activity window.
- [x] Search returned the Claude model activity.
- [x] The stop request completed the session and the F1 server shut down cleanly.

## Sanitized evidence

[The retained source-runtime receipt](evidence/2026-11-24-cypack-1657-source-runtime.json) records only the version, source, tool/result, lifecycle, and limitation fields needed for review. It excludes account identifiers, credentials, environment values, and raw query options.

## Supporting checks

- `./scripts/extract-claude-tools.sh` completed against Claude Code 2.1.331 with 26 native tools and three resource-capability additions: `ListMcpResourcesTool`, `ReadMcpResourceDirTool`, and `ReadMcpResourceTool`.
- The extracted catalog is unchanged from 2.1.330. Cyrus intentionally retains four context-dependent capabilities beyond the 29-tool fixture: `PushNotification`, `LSP`, `RemoteTrigger`, and `DesignSync`.
- The monorepo build and typecheck passed.
- Focused Claude runner, core, and EdgeWorker compatibility suites passed: 381 tests.

## Claude Code 2.1.331 dispositions

| Upstream behavior | Cyrus disposition |
| --- | --- |
| Edit and Write results now report text changed through `canUseTool.updatedInput`. | Accepted as an upstream result-correctness fix. Cyrus preserves the SDK result and does not reconstruct permission-time edits independently. |
| Browser SDK event streams now honor `Retry-After` and retain queued notices. | Accepted as an upstream transport fix. Cyrus does not replace or weaken the SDK retry timing. |
| `listSessions()` without a limit no longer opens every transcript concurrently. | Accepted as an upstream resource-safety fix. Cyrus does not impose a conflicting transcript scan. |
| `rewindFiles()` refuses when managed settings disable checkpointing and no longer deletes files after a failed restore. | Accepted as an upstream managed-policy and data-safety boundary. Cyrus does not bypass the refusal or add cleanup after a failed restore. |
| Foreground and background subagent task notifications consistently name their output file. | Accepted as an upstream event-shape correction. Cyrus treats the field as runtime-provided metadata. |
| Agent SDK 0.3.331 remains on the same 26 native plus three MCP-resource tool registry as 0.3.330. | The carried-forward static catalog remains current; no additional default-list or migration change is needed for the .331 increment. |

## Limitation and next gate

This source-worktree drive did not enable the SDK sandbox and did not install from npm. It validates the committed runtime and F1 path, but final acceptance still requires the issue-mandated immutable npm test candidate, registry installation, and the matching Hosted `cyrus-core` pin.
