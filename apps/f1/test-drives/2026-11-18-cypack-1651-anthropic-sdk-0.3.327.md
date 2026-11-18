# CYPACK-1651: Anthropic SDK 0.3.327 runtime verification

**Date:** 2026-11-18
**Goal:** Verify that the Claude 2.1.327 runtime initializes through Cyrus with the refreshed tool registry and preserves coherent F1 lifecycle behavior.

## Scenario

F1 created a disposable repository and routed an inspection-only issue through the real `ClaudeRunner` query path. The prompt required Claude to read `package.json`, run `pwd`, and return the exact marker `SDK_RUNTIME_327_OK` without modifying files.

## Results

- [x] The F1 server started and reported ready.
- [x] The issue tracker created `issue-1` / `DEF-1` and accepted repository selection.
- [x] EdgeWorker created the `DEF-1` worktree and initialized Claude Code 2.1.327 through `@anthropic-ai/claude-agent-sdk` 0.3.327.
- [x] Cyrus supplied its 33-tool engineering catalog, including `WebFetch` and the three MCP resource-discovery tools.
- [x] The SDK accepted the session's array-based hook configuration and serializable initialize options, covering the release's two breaking validation changes.
- [x] Elicitation, prompt, routing, model, and authentication-error activities rendered coherently; pagination returned the requested activity window.
- [x] The session stopped and the F1 server shut down cleanly.
- [ ] Repository `Read` and `Bash` tool execution could not run because the host's stored Claude OAuth token has been revoked.

## Supporting checks

- `./scripts/extract-claude-tools.sh` completed against Claude Code 2.1.327 with 26 clean built-ins and exactly three resource-capability additions: `ListMcpResourcesTool`, `ReadMcpResourceDirTool`, and `ReadMcpResourceTool`.
- The extracted catalog is unchanged from 2.1.326. Cyrus intentionally retains four capabilities beyond that 29-tool native fixture: `PushNotification`, `LSP`, `RemoteTrigger`, and `DesignSync`.
- `pnpm build` passed for all workspace packages.
- All 153 `cyrus-claude-runner` tests passed on 0.3.327.
- The focused edge-worker compatibility suite passed all 7 tests, including managed-MCP warning handling and sandboxed Bash approval configuration.

## Disposition

The 2.1.327 process, tool registry, initialize-option validation, activity delivery, pagination, and shutdown paths are verified. A fresh Claude login is required to repeat the repository tool calls; the same real tool path passed on 2.1.326 one day earlier, and the 0.3.327 extraction plus automated compatibility coverage passed in this change.
