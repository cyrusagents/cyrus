# CYPACK-1646: Anthropic SDK 0.3.325 sandbox reconciliation

**Date:** 2026-11-15
**Initial F1 source:** `151f79d6` (`cypack-1646`)
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

- The review-remediated `./scripts/extract-claude-tools.sh` constructs the native CLI environment from an allowlist, uses a fresh home/config directory, routes the placeholder provider exclusively to an ephemeral `127.0.0.1` fixture, disables nonessential traffic, and terminates the complete process group after a 20-second deadline. A regression injects Anthropic auth, Bedrock, Vertex, Foundry, AWS, Google and proxy settings into the parent and proves none reach the child; a second regression proves the deadline.
- That credential-free check completed against the installed Claude Code 2.1.325 binary in under one second. It reported 26 clean built-ins and exactly three resource-capability additions: `ListMcpResourcesTool`, `ReadMcpResourceDirTool`, and `ReadMcpResourceTool`. No provider request reached a non-loopback address.
- `RunnerConfigBuilder.writable-paths.test.ts` asserts the SDK 0.3.325 sandbox opt-in together with unsandboxed-command denial and filesystem containment.
- The full package suite, CLI suite, build, typecheck, lint, and audit passed separately.

## Representative Cyrus catalog and override behavior

The real F1 query construction selected Cyrus's 33-tool engineering catalog. It contains `WebFetch`, all three resource-discovery tools, and four Cyrus capabilities beyond the native 29-tool resource fixture (`PushNotification`, `LSP`, `RemoteTrigger`, and `DesignSync`). The platform defaults resolve as follows:

- Linear: 38 entries = 33 platform tools plus `mcp__linear`, `mcp__plane`, `mcp__cyrus-tools`, `mcp__cyrus-docs`, and `mcp__slack`.
- GitHub: 36 entries = 33 platform tools plus `mcp__linear`, `mcp__cyrus-tools`, and `mcp__cyrus-docs`.
- Slack: unchanged at 19 entries; it retains `WebFetch` and its existing four MCP scopes but does not gain the three resource-discovery tools.

`EdgeWorker.dynamic-tools.test.ts` and `EdgeWorker.multi-repo-tools.test.ts` preserve the existing resolution contract: workspace platform settings and repository/prompt settings are explicit overrides, repository lists are returned verbatim, and multi-repository Linear sessions union the independently resolved lists. The SDK update does not silently append resource tools or MCP scopes to a custom override.

## Upstream 0.3.325 permission effects

- **Outside-repository read-only Git:** the SDK now sends read-only Git commands for an untrusted repository through the permission flow. Cyrus supplies every configured repository and attachment path in its read/tool and sandbox allowlists. A command targeting any other repository is not newly trusted: it must already match the selected Bash grant, passes through Cyrus's noninteractive callback when present, and remains constrained by the OS sandbox. With sandboxing enabled it cannot fall back to an unsandboxed command.
- **Noninteractive sandboxed Bash:** Cyrus explicitly opts into `autoAllowBashIfSandboxed: true` to preserve unattended execution and separately sets `allowUnsandboxedCommands: false`. Explicit `disallowedTools` remains installed as an independent deny layer. The installed intended-identity acceptance still requires successful `Read(package.json)`, foreground sandboxed `Bash(pwd)` with timeout 10000, exact `SDK_RUNTIME_OK`, a successful terminal result, and a clean stop; configuration propagation alone does not satisfy it.
- **Hook with no verdict:** 0.3.325 allows the tool to continue but emits a tagged `system/informational` warning when a `PreToolUse` hook fails, cannot answer, or times out. Cyrus retains the raw frame in its JSON log and now posts the `hook_no_verdict` warning as a durable issue thought without marking the session failed. Other progress-only lifecycle frames remain non-durable.
- **Managed settings precedence:** Cyrus does not call `applyFlagSettings()`, so its new reject-on-layer-discard behavior does not change this path. User, project, and local settings remain loaded, while Cyrus continues to pass explicit `permissionMode: "default"`, allow/deny lists, sandbox settings, and hooks. Machine/organization managed policy remains upstream-authoritative; this update does not attempt to override it.

## Disposition

Query construction, routing, worktree setup, sandbox policy propagation, activity rendering, pagination, and shutdown are verified. Authenticated tool execution remains blocked on an authorized Claude credential refresh; this startup/configuration evidence is not presented as proof that Bash executed.
