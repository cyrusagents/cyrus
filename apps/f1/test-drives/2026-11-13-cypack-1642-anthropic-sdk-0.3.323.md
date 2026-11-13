# CYPACK-1642: Anthropic SDK 0.3.323 runtime reconciliation

**Date:** 2026-11-13  
**Tested source:** `c20eb7c7` (`cypack-1642`)  
**Goal:** Verify Claude Code 2.1.323 tool availability through a representative Cyrus issue session, including an explicit resource-capable MCP server.

## Scenario

F1 created a fresh single-repository issue and worktree. The repository included a minimal stdio MCP fixture that advertised the MCP `resources` capability. The inspection-only issue asked the agent to report the availability of `WebFetch`, `ListMcpResourcesTool`, `ReadMcpResourceDirTool`, and `ReadMcpResourceTool` without editing files.

The drive used the existing local Claude authentication state. It did not add, refresh, or replace credentials.

## Results

- [x] F1 server started on port 3600.
- [x] `issue-1` / `DEF-1` and `session-1` were created.
- [x] Repository selection, routing, and worktree creation completed.
- [x] Cyrus passed `permissionMode: "default"`, `strictMcpConfig: true`, the expected hooks and approval callback, and 33 platform-default tools plus scoped read grants.
- [x] The Cyrus allow-list retained `WebFetch` and all three MCP resource tools.
- [x] The Claude init message reported both `resource-fixture` and `cyrus-docs` connected.
- [x] The Claude init message advertised `ListMcpResourcesTool`, `ReadMcpResourceDirTool`, and `ReadMcpResourceTool`.
- [ ] The representative init message did not advertise `WebFetch`, even though Cyrus supplied it in `allowedTools`. A separate isolated default-permission 2.1.323 init did advertise `WebFetch`, so Cyrus retains it as supported; this environment-specific suppression remains observable rather than being encoded into the defaults.
- [ ] Authenticated tool invocation and final model response were blocked because the existing Claude OAuth token had expired. No credential change was authorized for this drive.
- [ ] Shutdown logged a state-file rename race after the failed session, although the server subsequently reported a graceful stop.

## Exact non-secret runtime evidence

The structured query-options event recorded:

- `permissionMode=default`
- `strictMcpConfig=true`
- `hasCanUseTool=true`
- `hasHooks=true`
- `hasSandbox=false` (the F1 server had sandboxing disabled)
- MCP servers: `resource-fixture`, `cyrus-docs`
- allowed tools included `WebFetch`, `ListMcpResourcesTool`, `ReadMcpResourceDirTool`, and `ReadMcpResourceTool`

The SDK init message recorded Claude Code model `claude-sonnet-5-5`, connected status for both configured MCP servers, and all three resource-discovery tools in the actual runtime tool registry.

## Supporting checks

- The isolated extraction script produced 28 clean default tools including `WebFetch`.
- Adding the resource-capable fixture produced exactly three additional tools: `ListMcpResourcesTool`, `ReadMcpResourceDirTool`, and `ReadMcpResourceTool`.
- Unit coverage verifies the SDK 0.3.323 permission re-check callback while sandbox settings remain active, native resume and strict MCP plumbing, and non-durable handling of hook/tool/auth progress signals.

## Disposition

The tool-default correction and connected-resource behavior are verified. The installed authenticated-runtime acceptance gate is still blocked on an existing credential refresh or replacement by an authorized owner. Rerun this exact F1 scenario after that authorization; do not treat the startup-only evidence as authenticated tool-execution proof.
