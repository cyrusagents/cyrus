# CYPACK-1652: Anthropic SDK 0.3.328 runtime verification

**Date:** 2026-11-19
**Goal:** Verify that Claude Code 2.1.328 initializes through Cyrus with the refreshed tool registry and preserves coherent F1 session activity, while recording the remaining installed-runtime acceptance gate exactly.
**Test repository:** `/private/tmp/f1-cypack-1652-20261119`

## Scenario

F1 created a disposable repository and routed an inspection-only issue through the real `ClaudeRunner` query path. The prompt requested `Read(package.json)`, a foreground `pwd` command with timeout `10000`, and the agreed exact marker `SDK_RUNTIME_OK` without modifying files.

## Verification results

### Issue tracker

- [x] Server health and ready status returned successfully.
- [x] `issue-1` / `DEF-1` was created and exposed through the CLI tracker.
- [x] Repository selection accepted `F1 Test Repository` and resumed the pending session.

### EdgeWorker and Claude runtime

- [x] EdgeWorker created the `DEF-1` worktree from local `main`.
- [x] Claude Code 2.1.328 initialized through `@anthropic-ai/claude-agent-sdk` 0.3.328.
- [x] Cyrus supplied its 33-tool engineering catalog, including `WebFetch` and the three resource-discovery tools.
- [x] The session used the hardened shell-startup environment and top-level MCP configuration carried forward from the 0.3.323-0.3.327 compatibility work.
- [ ] Repository `Read`, foreground `Bash(pwd)`, and the exact final marker did not run because the host's stored Claude OAuth token has expired.

### Activity rendering

- [x] Elicitation, prompt, acknowledgment, routing, model, and authentication-error activities rendered coherently.
- [x] Pagination returned the requested three-activity window.
- [x] Search returned the Claude model activity.
- [x] The session stop request was accepted and the F1 server shut down cleanly.

## Supporting checks

- `./scripts/extract-claude-tools.sh` completed against Claude Code 2.1.328 with 26 clean built-ins and exactly three resource-capability additions: `ListMcpResourcesTool`, `ReadMcpResourceDirTool`, and `ReadMcpResourceTool`.
- The extracted catalog is unchanged from 2.1.327. Cyrus intentionally retains four context-dependent capabilities beyond the 29-tool fixture: `PushNotification`, `LSP`, `RemoteTrigger`, and `DesignSync`.
- `pnpm build`, `pnpm typecheck`, package tests, lint, and `pnpm audit` passed before the drive. Lint reported only existing warnings.

## Claude Code 2.1.328 dispositions

| Upstream behavior | Cyrus disposition |
| --- | --- |
| A deferred tool can run automatically on `resume` or `continue`; `CLAUDE_CODE_DISABLE_DEFERRED_TOOL_RESUME` opts out. | Cyrus forces the opt-out for cold and pre-warmed sessions. An unattended continuation must not execute a call that any loaded user, project, local, plugin, or managed hook intentionally deferred. Process, repository, and runner environment layers cannot override it. |
| A shell command rewritten by a `PermissionRequest` hook now uses the rewrite's permission result to decide whether it is sandboxed; `canUseTool` is unchanged. | Accepted. Cyrus supplies no `PermissionRequest` rewrite hook. A loaded external hook's rewritten command must be checked as the rewritten command; Cyrus's explicit permission mode, deny rules, configured sandbox, and `canUseTool` callback remain unchanged. |
| With `CLAUDE_CODE_FORK_SUBAGENT=0`, subagents wait for their own subagents and one background chain has a default ten-minute ceiling. | Inactive by design. Cyrus does not set `CLAUDE_CODE_FORK_SUBAGENT=0` or `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`; default fork subagents retain the parent tools, permissions, hooks, settings, and sandbox. |
| Managed-settings plugins can install sooner in SDK sessions, and a short run can exit up to 30 seconds later. | Accepted without `CLAUDE_CODE_SYNC_PLUGIN_INSTALL`. Cyrus keeps plugin installation asynchronous and its stop path bounded; a configured managed plugin may become available to a later session rather than delaying every start synchronously. |
| Third-party providers can default interactive sessions and plan/Bash prompts to auto mode. | No implicit default is used. Cold and pre-warmed Cyrus sessions pass `permissionMode: "default"`; an explicit Cyrus Automatic-tool setting passes `"auto"`. The same contract applies to first-party, Bedrock, Vertex, Foundry, gateways, and telemetry-disabled sessions. |
| Code Mode no longer runs managed `UserPromptSubmit` hooks on script output, and managed `PostToolUse` hooks no longer run for calls refused before execution. | Accepted. Cyrus does not rely on script output re-entering `UserPromptSubmit`, and its own `PostToolUse` effects are intended only for calls that ran. Cyrus leaves hook `onFailure` unset (warn-and-continue); intentional policy blocks still return explicit block decisions. |

## Environment contract

Ordinary cold and pre-warmed Cyrus Claude sessions share `CYRUS_SESSION_ENV`: `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`, `CLAUDE_CODE_DISABLE_DEFERRED_TOOL_RESUME=1`, `CLAUDE_CODE_DISABLE_SHELL_HEAD_START=1`, `CLAUDE_CODE_ENABLE_TASKS=true`, `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`, `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1`, and `MCP_CONNECTION_NONBLOCKING=true`. The two `DISABLE_*` security boundaries are applied after parent, repository, and runner environment layers. `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` remains deliberately unset under CYPACK-1108. `CLAUDE_CODE_FORK_SUBAGENT`, `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`, and `CLAUDE_CODE_SYNC_PLUGIN_INSTALL` remain unset.

The credential-free tool extractor does **not** reuse the ordinary session environment. It constructs an isolated home/config/cache, points `ANTHROPIC_BASE_URL` only at a loopback 401 fixture, uses the non-secret sentinel API key, and sets extraction-only `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`, and `DISABLE_TELEMETRY=1`. It excludes operator credentials, cloud-provider selectors, credential paths, and proxy variables, and stops as soon as the init tool registry is captured.

## Final installed-runtime gate

Before merge, preserve the exact bundled binary, `CLAUDE_CONFIG_DIR=/Users/agentops`, the empty secure-storage override selecting the existing keychain service, OS user, auth method/provider, and intended account digest. After the bounded on-host human authentication handoff, the registry-installed matching runner/core candidate must complete, in order, configured-sandbox `Read(package.json)` → foreground `Bash(pwd, timeout 10000)` → exact final text `SDK_RUNTIME_OK` → a non-error result with no `session_writes_lost` → clean stop. No generic PATH login, off-host credential refresh, alternate account, or event publication is part of that handoff.

## Disposition

Runtime initialization, tool-catalog construction, worktree creation, activity delivery, pagination, search, and shutdown are verified. This drive does not claim repository-tool acceptance: it stopped at the expired OAuth error before either tool ran, and its original `SDK_RUNTIME_328_OK` request was not the agreed final marker. The exact installed-runtime receipt above remains open; no credential mutation or alternate account was used.
