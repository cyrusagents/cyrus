# Test Drive: CYPACK-1478 Release v0.2.70

**Date**: 2026-08-27
**Goal**: Validate the local F1 issue, Claude session, and activity-rendering flow before publishing v0.2.70.
**Test Repo**: `/tmp/f1-release-v0.2.70-23d794e4/repo`
**F1 Port**: `3600`
**Reference Issue**: CYPACK-1478 (fix(cli): thread strictMcpConfig from config file into EdgeWorker startup config, #1440) — the strictMcpConfig fix and its accompanying schema-completeness guardrails are the primary CLI/EdgeWorker changes carried by this release.

## Verification Results

### Issue-Tracker
- [x] Issue created
- [x] Issue ID returned
- [x] Issue metadata accessible through session view

### EdgeWorker
- [x] Session started
- [x] Worktree created
- [x] Activities tracked
- [x] Claude processed the issue successfully

### Renderer
- [x] Activity format correct
- [x] Pagination works
- [ ] Search works (the F1 CLI has no session-search command)

## Session Log

```bash
apps/f1/f1 init-test-repo --path /tmp/f1-release-v0.2.70-23d794e4/repo
ATMIKO_PORT=3600 ATMIKO_DEFAULT_RUNNER=claude \
  ATMIKO_REPO_PATH=/tmp/f1-release-v0.2.70-23d794e4/repo \
  bun run apps/f1/server.ts
ATMIKO_PORT=3600 apps/f1/f1 ping
ATMIKO_PORT=3600 apps/f1/f1 status
```

Result: port 3600 was confirmed free before starting; the fresh test repository was initialized (token-bucket implemented, sliding/fixed window + Redis adapter + tests left as TODOs, matching the standard F1 scaffold); the server started cleanly on port 3600 with no startup errors or warnings in the boot log. `status` returned `ready`. `ping` returned success but printed `Status: undefined` — this is a pre-existing F1 CLI/RPC field-name mismatch (`CLIRPCServer.handlePing` returns `{message: "pong", timestamp}` while `apps/f1/src/commands/ping.ts` reads `result.status`), unrelated to the CYPACK-1478 changes; not a regression and not release-blocking.

```bash
ATMIKO_PORT=3600 apps/f1/f1 create-issue \
  --title "Release v0.2.70 F1 validation" \
  --description "Validate the Atmiko v0.2.70 release by inspecting the configured repository and reporting its current implementation status. Do not edit files."
ATMIKO_PORT=3600 apps/f1/f1 start-session --issue-id issue-1
ATMIKO_PORT=3600 apps/f1/f1 prompt-session \
  --session-id session-1 \
  --message "Use the configured test repository for this issue."
```

Result: F1 created `issue-1` / `DEF-1` and `session-1`. The session immediately elicited a repository selection ("Which repository should I work in for this issue?"); after `prompt-session` responded with the configured-repo instruction, EdgeWorker created the `DEF-1` git worktree, resolved routing to the "F1 Test Repository", assigned a Claude SDK session ID (`59b17dcb-2677-4b50-9f9d-d3f00ca6b41d`), and reported model `claude/claude-sonnet-5`.

One benign SDK-level warning was observed in the server log during runner startup: `canUseTool will not be invoked for: Bash, Task, WebFetch, ... (code: CLAUDE_SDK_CAN_USE_TOOL_SHADOWED)`. This is an informational warning from the bundled `@anthropic-ai/claude-agent-sdk` about bare `allowedTools` entries bypassing the `canUseTool` callback; it did not block or degrade the session (all 16 timeline activities and the final response rendered correctly afterward), and is unrelated to the strictMcpConfig fix under test.

```bash
ATMIKO_PORT=3600 apps/f1/f1 view-session --session-id session-1
ATMIKO_PORT=3600 apps/f1/f1 view-session --session-id session-1 --limit 10 --offset 0
ATMIKO_PORT=3600 apps/f1/f1 view-session --session-id session-1 --limit 10 --offset 10
```

Result: the Claude-backed inspection completed successfully (`Session completed (subtype: success)`, 42 raw SDK messages). The session rendered 16 coherent timeline activities: `elicitation` → `prompt` → 3x `thought` (acknowledgement, routing decision, model selection) → 10x `action` (Bash/Read tool calls exploring the repo) → final `response`. The final response was a well-structured Markdown status report covering implemented features (token bucket algorithm, in-memory storage adapter, public API/types), explicitly TODO'd features (sliding window, fixed window, Redis adapter, tests), a build-tooling caveat (no `node_modules` installed, so `tsc --noEmit` could not be run), and confirmation that no files were modified — correctly honoring the inspection-only instruction. Pagination with `--limit 10 --offset 0` returned the first 10 activities plus a "Showing 10 of 16 activities / Use --limit and --offset to view more" footer; `--offset 10` returned the remaining 6 activities including the final response, confirming correct windowing.

Post-session filesystem check confirmed `git status --short` was empty in the `DEF-1` worktree (still at the single scaffold commit `b6f816c`) — the agent made no edits, consistent with the inspection-only task.

```bash
ATMIKO_PORT=3600 apps/f1/f1 stop-session --session-id session-1
```

Result: the session stop request succeeded (`Session stopped successfully`, EdgeWorker logged "Stopped session session-1 (interrupt not supported)" since the session had already completed). The server was then sent `SIGTERM` and shut down gracefully, logging `✅ Saved EdgeWorker state for 1 sessions` and `✅ Server stopped gracefully`.

## Final Retrospective

F1 validated the full local server, issue tracker, repository-selection recovery, worktree creation, Claude execution, activity rendering, pagination, successful final response, session stop, and graceful server shutdown paths for v0.2.70. All core pass/fail criteria from the F1 skill were met: server started without error, issue and session creation succeeded, activities appeared and rendered coherently, the final response was well-formed, the session stopped cleanly, and no unhandled exceptions occurred.

Two non-blocking, pre-existing observations were noted (neither is a regression introduced by the CYPACK-1478 changes being released):
1. `f1 ping` prints `Status: undefined` due to a field-name mismatch between the RPC handler (`message`) and the CLI (`status`) — cosmetic only, health check still reports success.
2. A benign `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` warning is logged by the bundled Claude Agent SDK about bare `allowedTools` entries; it does not affect session behavior or output.

As with the v0.2.69 drive, the generated test repository intentionally has unfinished algorithms and tests, and the agent correctly performed an inspection-only task without modifying it. No regressions were observed in the areas touched by CYPACK-1478 (config-file → EdgeWorker startup config field propagation) — the session started, routed, and executed normally end-to-end. **v0.2.70 is validated for publishing.**
