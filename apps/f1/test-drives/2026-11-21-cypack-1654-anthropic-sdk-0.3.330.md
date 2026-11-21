# CYPACK-1654: Anthropic SDK 0.3.330 runtime verification

**Date:** 2026-11-21

**Goal:** Verify that Cyrus runs the Claude Agent SDK 0.3.330 / Claude Code 2.1.330 update through its real worktree, tool, and activity pipeline.

**Test repository:** `/private/tmp/f1-cypack-1654.epVD1R/repo`

## Scenario

F1 created a disposable repository and routed an inspection-only issue through the real `ClaudeRunner` query path. The prompt required `Read(package.json)`, a foreground `Bash(pwd)` call with timeout `10000`, and the exact final marker `SDK_RUNTIME_OK`, without modifying files.

## Verification results

### Issue tracker

- [x] Health and ready status returned successfully.
- [x] `issue-1` / `DEF-1` was created and exposed through the CLI tracker.
- [x] Repository selection accepted `F1 Test Repository` and resumed the pending session.

### EdgeWorker and Claude runtime

- [x] Installed packages resolved to `@anthropic-ai/claude-agent-sdk` 0.3.330 and `@anthropic-ai/sdk` 1.12.0.
- [x] The bundled native executable reported Claude Code 2.1.330.
- [x] EdgeWorker created the `DEF-1` worktree from local `main`.
- [x] Cyrus supplied its 33-tool engineering catalog, including the three resource-discovery tools.
- [x] Claude read `package.json`, ran foreground `Bash(pwd)`, and returned exactly `SDK_RUNTIME_OK`.
- [x] The session completed successfully without `session_writes_lost` or an unhandled error.

### Activity rendering

- [x] Elicitation, prompt, acknowledgment, routing, model, action, and response activities rendered coherently.
- [x] Pagination returned the requested three-activity window.
- [x] Search returned the Claude model activity.
- [x] The stop request completed the session and the F1 server shut down cleanly.

## Supporting checks

- `./scripts/extract-claude-tools.sh` completed against Claude Code 2.1.330 with 26 native tools and exactly three resource-capability additions: `ListMcpResourcesTool`, `ReadMcpResourceDirTool`, and `ReadMcpResourceTool`.
- The extracted catalog is unchanged from 2.1.329. Cyrus intentionally retains four context-dependent capabilities beyond the 29-tool fixture: `PushNotification`, `LSP`, `RemoteTrigger`, and `DesignSync`.
- The monorepo build passed.
- Focused Claude runner and EdgeWorker compatibility suites passed: 104 tests across eight files.

## Claude Code 2.1.330 dispositions

| Upstream behavior | Cyrus disposition |
| --- | --- |
| Invalid host, user, project, or local settings now emit `settings_not_in_effect`. | Cyrus logs the warning and posts it as a durable issue-timeline thought so missing settings or policy cannot silently degrade a run. A focused regression test covers this tag. |
| A `SessionStart` hook's `CLAUDE_ENV_FILE` variables now reach Bash after `continue`. | Accepted as an upstream continuation fix. Cyrus preserves the same session environment and hook configuration on resume and adds no competing environment-file layer. |
| `stopTask()` no longer leaves Claude waiting when the background agent finishes concurrently. | Accepted as an upstream background-task lifecycle fix. Cyrus does not add another task-completion state machine around the SDK. |
| `query()` now rejects a `settings` string that is not valid JSON. | Cyrus passes structured settings and managed settings rather than a raw JSON string; its current configuration is unaffected, and malformed future callers now fail visibly. |
| SDK MCP calls avoid lost or swapped results across reconnects by allowing high numeric request IDs. | Accepted as an upstream transport fix. Cyrus treats JSON-RPC request IDs as opaque and does not narrow or rewrite them. |
| Agent Platform fast mode now honors settings and reports the running model's `fast_mode_state`. | Accepted. Cyrus does not override Agent Platform billing or synthesize initialize-state fields; it forwards the runtime-selected model and SDK state. |

## Disposition

The 0.3.330 runtime, refreshed tool catalog, worktree creation, repository tools, activity delivery, pagination, search, and shutdown all passed. This closes the authenticated runtime gap recorded in the carried-forward CYPACK-1653 drive.
