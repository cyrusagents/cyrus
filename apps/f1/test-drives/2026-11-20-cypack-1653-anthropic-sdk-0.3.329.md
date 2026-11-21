# CYPACK-1653: Anthropic SDK 0.3.329 runtime verification

**Date:** 2026-11-20
**Goal:** Verify that Claude Code 2.1.329 initializes through Cyrus with the refreshed tool registry and preserves coherent F1 session activity, while recording the remaining authenticated runtime gate exactly.
**Test repository:** `/private/tmp/f1-cypack-1653.iZyoiW/repo`

## Scenario

F1 created a disposable repository and routed an inspection-only issue through the real `ClaudeRunner` query path. The prompt requested `Read(package.json)`, a foreground `pwd` command with timeout `10000`, and the exact marker `SDK_RUNTIME_OK` without modifying files.

## Verification results

### Issue tracker

- [x] Server health and ready status returned successfully.
- [x] `issue-1` / `DEF-1` was created and exposed through the CLI tracker.
- [x] Repository selection accepted `F1 Test Repository` and resumed the pending session.

### EdgeWorker and Claude runtime

- [x] EdgeWorker created the `DEF-1` worktree from local `main`.
- [ ] Fresh initialization with `@anthropic-ai/sdk` 1.12.0 remains pending; the prior run initialized Claude Code 2.1.329 through `@anthropic-ai/claude-agent-sdk` 0.3.329 with `@anthropic-ai/sdk` 1.11.0 before 1.12.0 was published.
- [x] Cyrus supplied its 33-tool engineering catalog, including `WebFetch` and the three resource-discovery tools.
- [x] The session used the hardened shell-startup/deferred-resume environment and top-level MCP configuration carried forward from the 0.3.323-0.3.328 compatibility work.
- [ ] Repository `Read`, foreground `Bash(pwd)`, and the exact final marker did not run because the host's stored Claude OAuth token has expired.

### Activity rendering

- [x] Elicitation, prompt, acknowledgment, routing, model, and authentication-error activities rendered coherently.
- [x] Pagination returned the requested three-activity window.
- [x] Search returned the Claude model activity.
- [x] The session stop request was accepted and the F1 server shut down cleanly.

## Supporting checks

- `./scripts/extract-claude-tools.sh` completed against Claude Code 2.1.329 with 26 clean built-ins and exactly three resource-capability additions: `ListMcpResourcesTool`, `ReadMcpResourceDirTool`, and `ReadMcpResourceTool`.
- The extracted catalog is unchanged from 2.1.328. Cyrus intentionally retains four context-dependent capabilities beyond the 29-tool fixture: `PushNotification`, `LSP`, `RemoteTrigger`, and `DesignSync`.
- `pnpm build` and 64 focused compatibility tests passed before the drive. Full package, type, lint, and audit gates are recorded separately in the pull request.

## Claude Code 2.1.329 dispositions

| Upstream behavior | Cyrus disposition |
| --- | --- |
| A deferred tool can run automatically on `resume` or `continue`; `CLAUDE_CODE_DISABLE_DEFERRED_TOOL_RESUME` opts out. | Cyrus forces the opt-out for cold and pre-warmed sessions. An unattended continuation must not execute a call that any loaded user, project, local, plugin, or managed hook intentionally deferred. Process, repository, and runner environment layers cannot override it. |
| Claude Code 2.1.327 strictly validates SDK options and requires hook collections to be arrays. | Cyrus's query, startup, prewarm, and hook configurations serialize cleanly under 0.3.329; focused runner and EdgeWorker compatibility tests cover the affected paths. |
| Claude Code 2.1.329 reports `managed_hooks_not_loaded` and accepts `permissions.workingDirectoriesExclude` from settings. | Cyrus forwards SDK informational messages to the issue timeline and continues to let the bundled runtime resolve user, project, local, plugin, and managed settings. No duplicate Cyrus setting is introduced. |
| `SpareProcess.claim()` now honors `autoCompactWindow`, and idle sessions release large unused tool-result data. | Accepted as upstream warm-session and memory fixes. Cyrus's prewarm path does not override either behavior. |
| A shell command rewritten by a `PermissionRequest` hook uses the rewrite's permission result to decide whether it is sandboxed; `canUseTool` is unchanged. | Accepted. Cyrus supplies no `PermissionRequest` rewrite hook. A loaded external hook's rewritten command is checked as the rewritten command; Cyrus's explicit permission mode, deny rules, configured sandbox, and `canUseTool` callback remain unchanged. |
| Third-party providers can default interactive sessions and plan/Bash prompts to auto mode. | No implicit default is used. Cold and pre-warmed Cyrus sessions pass `permissionMode: "default"`; an explicit Cyrus Automatic-tool setting passes `"auto"`. The same contract applies to first-party, Bedrock, Vertex, Foundry, gateways, and telemetry-disabled sessions. |
| Forked subagents now wait for their own subagents when the legacy `CLAUDE_CODE_FORK_SUBAGENT=0` path is selected, and the background wait ceiling remains configurable. | Cyrus accepts the upstream default fork behavior. It sets neither `CLAUDE_CODE_FORK_SUBAGENT` nor `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`, so it does not opt into the legacy path or override the upstream ceiling. Forks continue to inherit the parent session's tools, permissions, hooks, settings, and sandbox. |
| Managed plugins can finish loading asynchronously, and a removed plugin's MCP server now disconnects after `reload_plugins`. | Accepted as upstream lifecycle behavior. Cyrus leaves `CLAUDE_CODE_SYNC_PLUGIN_INSTALL` unset, relies on the init/tool catalog actually reported by the runtime, and does not hold session startup open for a managed plugin download. Missing managed hooks are surfaced through `managed_hooks_not_loaded`; Cyrus does not manufacture tools from a delayed or removed plugin. |
| Code Mode can activate when telemetry, nonessential traffic, or feature flags are disabled; managed settings can still turn it off. | Accepted. Ordinary Cyrus sessions do not force those traffic or telemetry flags and continue to defer Code Mode policy to the loaded settings. The credential-free extractor sets `DISABLE_TELEMETRY=1` and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, but it stops immediately after the init registry and never submits a model request or executes Code Mode. |
| A Code Mode `PreToolUse` hook error no longer refuses the tool call unless the hook sets `onFailure: "block"`. | Cyrus preserves its explicit policy: its hook matchers leave `onFailure` unset, so unexpected hook failures warn and continue; an intentional policy denial still returns an explicit block decision. The SDK's `hook_no_verdict` and managed-hook warnings remain visible in the issue timeline. |
| Claude Code removed the automatic retry after a provider `max_tokens` error. | Accepted. Cyrus does not inject `CLAUDE_CODE_MAX_OUTPUT_TOKENS` or add a second retry layer. A provider/gateway with a lower output ceiling must configure the documented environment value explicitly, and an exhausted request remains an error instead of being replayed invisibly. |
| Most scheduled tasks saved by earlier versions need scheduling again in a new signed-in session; resuming their own session still runs them. | Accepted. Cyrus treats `CronCreate`, `ScheduleWakeup`, and `/loop` work as session-scoped pending work, keeps that session active while work remains, and resumes the same session. It does not promise that a saved task migrates into a different newly signed-in session. |
| A failed macOS Keychain save during login renewal now reports `invalid_request` with null API status instead of `authentication_failed` with 401. | Accepted without rewriting upstream authentication errors. The final installed-runtime gate still requires the preserved config/keychain service, intended account digest, `loggedIn: true`, successful initialization, and successful tools; a failed renewal with either error shape cannot satisfy that receipt. |

## Environment contract

Ordinary cold and pre-warmed Cyrus Claude sessions share `CYRUS_SESSION_ENV`: `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`, `CLAUDE_CODE_DISABLE_DEFERRED_TOOL_RESUME=1`, `CLAUDE_CODE_DISABLE_SHELL_HEAD_START=1`, `CLAUDE_CODE_ENABLE_TASKS=true`, `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`, `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1`, and `MCP_CONNECTION_NONBLOCKING=true`. The two `DISABLE_*` security boundaries are applied after parent, repository, and runner environment layers. `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` remains deliberately unset under CYPACK-1108. `CLAUDE_CODE_FORK_SUBAGENT`, `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`, and `CLAUDE_CODE_SYNC_PLUGIN_INSTALL` remain unset.

The credential-free tool extractor does **not** reuse the ordinary session environment. It constructs an isolated home/config/cache, points `ANTHROPIC_BASE_URL` only at a loopback 401 fixture, uses a non-secret sentinel API key, sets extraction-only traffic/Todo/telemetry flags, excludes operator credentials and provider selectors, and stops as soon as the init tool registry is captured.

## Final authenticated-runtime gate

The test release must preserve the exact bundled binary, the intended Claude config/keychain identity, OS user, auth method/provider, and intended account digest. After a bounded on-host authentication handoff, the registry-installed matching runner/core candidate must complete configured-sandbox `Read(package.json)` → foreground `Bash(pwd, timeout 10000)` → exact final text `SDK_RUNTIME_OK` → a non-error result with no `session_writes_lost` → clean stop. No alternate account or off-host credential substitution is part of that handoff.

## Disposition

Runtime initialization, tool-catalog construction, worktree creation, activity delivery, pagination, search, and shutdown are verified. This drive does not claim authenticated repository-tool acceptance: it stopped at the expired OAuth error before either tool ran. The registry-installed authenticated-runtime receipt remains open.
