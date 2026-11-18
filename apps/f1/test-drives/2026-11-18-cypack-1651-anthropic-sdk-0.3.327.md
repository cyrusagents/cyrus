# CYPACK-1651: Anthropic SDK 0.3.327 runtime verification

**Date:** 2026-11-18
**Goal:** Verify that the Claude 2.1.327 runtime initializes through Cyrus with the refreshed tool registry and preserves coherent F1 lifecycle behavior.

## Scenario

F1 created a disposable repository and routed an inspection-only issue through the real `ClaudeRunner` query path. The initial prompt required Claude to read `package.json`, run `pwd`, and return the exact marker `SDK_RUNTIME_327_OK` without modifying files. The final installed-package acceptance remains stricter: ordered `Read(package.json)`, foreground sandboxed `Bash(pwd)` with timeout exactly `10000`, exact final text `SDK_RUNTIME_OK`, a non-error result, and a clean stop.

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
- The later exact-head review passed four Node 22/24 checks, a strict frozen install with pnpm 10.33.1 and an unchanged lockfile, the dependency build, and 45 focused tests at `be9b2f854317871b7b0619c17ad713409840789e`. The branch was then reconciled with the current release base; final-head checks supersede this reviewed checkpoint.

## Claude Code 2.1.327 and Agent SDK 0.3.327 dispositions

- **Shell startup before approval is disabled.** Every cold and warmed Cyrus session sets `CLAUDE_CODE_DISABLE_SHELL_HEAD_START=1`. Cold sessions reapply it after process, repository `.env`, and runner-provided environment layers, so an untrusted repository cannot re-enable startup-file evaluation before Bash approval.
- **Path and worktree semantics remain Cyrus-owned.** Cyrus does not use the SDK `--worktree` option. GitService creates the outer issue worktree and `RunnerConfigBuilder` passes its absolute path as `cwd`; multi-repository siblings are forwarded only as absolute `additionalDirectories`. Relative workspace metadata is rejected rather than inheriting 2.1.327's changed `--worktree`/`--add-dir` resolution.
- **Unattended worktree exit remains explicit.** Linear and GitHub engineering defaults continue to list `ExitWorktree` in `allowedTools`. That explicit approval preserves the existing noninteractive behavior despite 2.1.327's new prompt-before-discard behavior; Cyrus still owns cleanup of the outer issue worktree.
- **The MCP reconnect reversion and numeric JSON-RPC IDs do not affect Cyrus's transport.** Cyrus never constructs in-process `createSdkMcpServer()` servers and does not put MCP servers inside agent definitions. It supplies stdio, HTTP, or SSE servers only through the top-level query `mcpServers` option, so the reverted in-process reconnect change and restored numeric in-process JSON-RPC IDs are outside this path.
- **Remote retry extension is accepted.** Top-level remote HTTPS MCP servers remain SDK-managed and inherit 0.3.327's longer retry lifetime. Cyrus adds no competing retry loop.
- **Nested-agent MCP deprecation is a non-use.** Cyrus does not pass an `agents` query option and therefore has no `agent.mcpServers` configuration to migrate.

## Security advisory correction

GitHub withdrew `GHSA-fc5q-39xc-vjpf` for `picomatch` at `2026-11-18T15:38:56Z`. It is recorded as withdrawn, not treated as an active unfixed vulnerability, and no audit override is requested for it.

## Disposition

The 2.1.327 process, tool registry, initialize-option validation, activity delivery, pagination, and shutdown paths are verified. The required installed configured-sandbox receipt is still pending an on-host human authorization handoff. Before that handoff, the verifier must bind the exact candidate source and package artifacts, native binary/version, configuration directories, OS user, auth method, provider, and intended account digest; it must reject provider/account override variables. No off-host credential refresh, generic PATH login, alternate account, or publication is part of that handoff.
