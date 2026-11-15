# CYPACK-1646: Anthropic SDK 0.3.325 sandbox reconciliation

**Date:** 2026-11-15
**Tested source:** `151f79d6` (`cypack-1646`)
**Goal:** Verify the Claude 2.1.325 session path receives Cyrus's refreshed tool registry and explicit sandboxed Bash approval policy.

## Scenario

F1 created a fresh issue and worktree for an inspection-only request to run `pwd` through Bash. The server ran with the egress sandbox enabled so the actual `RunnerConfigBuilder` and `ClaudeRunner` query path exercised the SDK 0.3.325 sandbox option changed by this update.

The drive used the existing local Claude authentication state. It did not add, refresh, or replace credentials.

## Results

- [x] F1 server and egress proxy started on port 3600.
- [x] `DEF-1` routed through `[repo=f1-test-repo]`, created a worktree, and started a Claude session.
- [x] Cyrus supplied 33 platform tools, including `WebFetch` and the three MCP resource-discovery tools.
- [x] The real Claude query carried `autoAllowBashIfSandboxed: true`, `allowUnsandboxedCommands: false`, and the expected read/write sandbox allowlists.
- [x] Thought, routing, model, and error activities rendered coherently; pagination returned the requested subset.
- [x] The session and server stopped cleanly, including the egress proxy.
- [ ] Authenticated Bash execution and the final `pwd` response were blocked because the existing Claude OAuth token had expired. No credential change was authorized for this drive.

## Supporting checks

- `./scripts/extract-claude-tools.sh` reported 28 clean default tools and exactly three additional resource-discovery tools with a resource-capable MCP fixture.
- `RunnerConfigBuilder.writable-paths.test.ts` asserts the SDK 0.3.325 sandbox opt-in together with unsandboxed-command denial and filesystem containment.
- The full package suite, CLI suite, build, typecheck, lint, and audit passed separately.

## Disposition

Query construction, routing, worktree setup, sandbox policy propagation, activity rendering, pagination, and shutdown are verified. Authenticated tool execution remains blocked on an authorized Claude credential refresh; this startup/configuration evidence is not presented as proof that Bash executed.
