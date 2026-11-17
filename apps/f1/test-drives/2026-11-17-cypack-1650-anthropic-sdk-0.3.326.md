# CYPACK-1650: Anthropic SDK 0.3.326 runtime verification

**Date:** 2026-11-17
**Goal:** Verify that the Claude 2.1.326 runtime starts through Cyrus with the refreshed tool registry, can use repository tools, and preserves the sandbox policy introduced with the Anthropic SDK update.

## Scenario

F1 created a disposable repository and routed an issue through the real `ClaudeRunner` query path. The prompt required Claude to read `package.json`, run `pwd`, and return the exact marker `SDK_RUNTIME_OK`. The drive used the existing local Claude authentication state and made no credential changes.

The scenario ran twice: first with Cyrus's egress/OS sandbox enabled to inspect the generated sandbox policy, then without the OS sandbox to distinguish a host-level sandbox limitation from an SDK runtime regression.

## Results

- [x] Claude Code 2.1.326 initialized through `@anthropic-ai/claude-agent-sdk` 0.3.326.
- [x] Cyrus supplied its 33-tool engineering catalog, including `WebFetch` and the three MCP resource-discovery tools.
- [x] Claude successfully read the disposable repository's `package.json`.
- [x] The sandboxed query carried `autoAllowBashIfSandboxed: true`, `allowUnsandboxedCommands: false`, and the expected repository allowlists.
- [x] The unsandboxed control run executed `pwd` and returned the exact `SDK_RUNTIME_OK` marker.
- [x] Thought, routing, model, action, and response activities rendered coherently, and the session stopped cleanly.
- [ ] The sandboxed run could not execute `pwd` because this macOS host rejected `sandbox-exec` policy application with exit code 71. The permission request was accepted before that host-level failure.

## Supporting checks

- `./scripts/extract-claude-tools.sh` completed against Claude Code 2.1.326 with 26 clean built-ins and exactly three resource-capability additions: `ListMcpResourcesTool`, `ReadMcpResourceDirTool`, and `ReadMcpResourceTool`.
- Cyrus intentionally retains four capabilities beyond that 29-tool native fixture: `PushNotification`, `LSP`, `RemoteTrigger`, and `DesignSync`.
- A focused `AgentSessionManager` regression verifies that the new `managed_mcp_arrived` informational frame becomes a durable warning without failing the session. The upstream condition was not synthetically triggered during the real runtime drive.
- The package suite, CLI suite, build, typecheck, lint, and dependency audit passed separately.

## Disposition

The authenticated 2.1.326 runtime, tool registry, repository read, Bash execution, activity delivery, and shutdown are verified. The failed sandboxed `pwd` is recorded as a host `sandbox-exec` limitation; the successful unsandboxed control run demonstrates that it is not an SDK or Cyrus runtime failure.
