# Internal Changelog

This changelog documents internal development changes, refactors, tooling updates, and other non-user-facing modifications.

## [Unreleased]

## [0.2.50] - 2026-04-30

### Added
- Added `push` event support to `GitHubEventTransport` (new `GitHubPushPayload`, `GitHubPushCommit` types, `GitHubCommentWebhookEvent` narrowing type). Push events are emitted without action filtering. Updated `extractComment*` utility functions and `GitHubMessageTranslator` to use `GitHubCommentWebhookEvent` instead of `GitHubWebhookEvent` for type safety. Added `getSessionsByBaseBranch(branchName, repositoryId)` query to `AgentSessionManager`. Added `handleGitHubPushWebhook` to `EdgeWorker` — extracts branch from `refs/heads/*`, finds repo config, looks up active sessions, streams XML rebase notification via `addStreamMessage`. ([CYPACK-978](https://linear.app/ceedar/issue/CYPACK-978), [#1004](https://github.com/ceedaragents/cyrus/pull/1004))
- Added blocked-by dependency deferral to `EdgeWorker`: `checkBlockedByDependencies` fetches issue relations via `fetchBlockingIssues` and filters to unresolved blockers. Blocked sessions are parked in a `parkedSessions` Map (keyed by issue ID). Added `isIssueStateChangeWebhook` type guard to cyrus-core for detecting `stateId` changes in `updatedFrom`. Added `handleIssueStateChange` handler — when blocking issues complete, removes them from parked sessions and replays `initializeAgentRunner`. Added `handleParkedSessionReprompt` (Branch 1.5 in prompted handler) for re-checking blockers on user re-prompt. Added `postThoughtActivity` to `ActivityPoster`. 12 new tests (5 for `getSessionsByBaseBranch`, 7 for `isIssueStateChangeWebhook`). ([CYPACK-978](https://linear.app/ceedar/issue/CYPACK-978), [#1004](https://github.com/ceedaragents/cyrus/pull/1004))

### Changed
- Documented dependency security policy in `CLAUDE.md`: prefer direct-dep bumps in the owning package; only use root `pnpm.overrides` when a direct-dep bump cannot reach the vulnerable transitive; remove overrides when a future bump makes them redundant. ([CYPACK-1101](https://linear.app/ceedar/issue/CYPACK-1101), [#1128](https://github.com/ceedaragents/cyrus/pull/1128))
- Improved `ClaudeRunner` diagnostics when `CYRUS_LOG_LEVEL=DEBUG`: the child subprocess now receives `DEBUG_CLAUDE_AGENT_SDK=1` so the Claude Agent SDK's own debug output (including `--debug-to-stderr`) is forwarded, and the full `query()` options are logged as JSON before dispatch. Non-serializable members (AbortController, async iterables, callbacks) are replaced with diagnostic placeholders so the output is valid JSON. ([CYPACK-1124](https://linear.app/ceedar/issue/CYPACK-1124), [#1153](https://github.com/cyrusagents/cyrus/pull/1153))

### Fixed
- De-flaked `packages/edge-worker/test/EgressProxy.test.ts`. The `Math.random()`-based port allocation in `beforeEach` collided on CI (EADDRINUSE on `127.0.0.1:19281`); tests now bind to port `0` and read the OS-assigned port via `proxy.getHttpProxyPort()` / `proxy.getSocksProxyPort()`. In `EgressProxy.startHttpProxy` / `startSocksProxy`, the stored port is updated to the bound `server.address().port`. Also fixed a `socket.write(reply); socket.destroy()` race in the SOCKS5 handler where the async write could be truncated before the denial reply reached the client — replaced with `socket.end(reply)` so the reply is flushed before FIN. ([CYPACK-1122](https://linear.app/ceedar/issue/CYPACK-1122), [#1147](https://github.com/ceedaragents/cyrus/pull/1147))

## [0.2.49] - 2026-04-22

_No internal-only changes._

## [0.2.48] - 2026-04-20

_No internal-only changes._

## [0.2.47] - 2026-04-20

### Changed
- Stopped deleting workspace-level issue trackers and activity sinks when removing repositories — they are keyed by workspace ID and may be needed by other repos in the same workspace or by repos about to be added in the same `configChanged` cycle. They are naturally replaced when workspace tokens are updated. ([CYPACK-1089](https://linear.app/ceedar/issue/CYPACK-1089), [#1120](https://github.com/ceedaragents/cyrus/pull/1120))

### Fixed
- Fixed typos in `packages/CLAUDE.md` webhook-constraints documentation (`additonal`, `repsoitory`, `agentSesion`, `intitialized`). ([CYPACK-1098](https://linear.app/ceedar/issue/CYPACK-1098), [#1126](https://github.com/ceedaragents/cyrus/pull/1126))

## [0.2.46] - 2026-04-16

### Fixed
- Fixed config reload ordering in `EdgeWorker.configChanged` handler — `updateLinearWorkspaceTokens()` now runs before `addNewRepositories()` so new repositories can look up their Linear workspace token during initialization. Previously, tokens were updated after repo addition, causing failures when both a new workspace and its first repository arrived in the same config change. ([CYPACK-1089](https://linear.app/ceedar/issue/CYPACK-1089), [#1112](https://github.com/ceedaragents/cyrus/pull/1112))

### Changed
- Removed `config: EdgeWorkerConfig` dependency from `PromptBuilder` — it was only used to check `handlers?.createWorkspace` for the working directory placeholder. Working directory is now passed explicitly via `workspaceRepoPaths` parameter through `buildIssueContextPrompt` → `buildIssueContextForPromptAssembly` → `buildNewSessionPrompt`. ([CYPACK-1088](https://linear.app/ceedar/issue/CYPACK-1088), [#1110](https://github.com/ceedaragents/cyrus/pull/1110))

## [0.2.45] - 2026-04-15

### Added
- Added `DEFAULT_REPOS_DIR` constant to `cyrus-core` and `getDefaultReposDir()` utility functions (in `apps/cli` and `packages/config-updater`) mirroring the existing `CYRUS_WORKTREES_DIR` / `getDefaultWorktreesDir()` pattern. Replaced all hardcoded `join(cyrusHome, "repos")` calls in `Application.ts`, `SelfAddRepoCommand.ts`, `repository.ts` handler, and `f1/server.ts`. ([CYPACK-1081](https://linear.app/ceedar/issue/CYPACK-1081), [#1104](https://github.com/ceedaragents/cyrus/pull/1104))
- Added `resolveClaudeCodeExecutablePath()` to `ClaudeRunner` — uses `createRequire(import.meta.url)` + `require.resolve()` to locate the SDK's `cli.js` in pnpm's `.pnpm` symlinked layout, bypassing the SDK's broken `import.meta.url` resolution. Ported from unmerged `cypack-762` branch (`42abcf22`). ([CYPACK-1066](https://linear.app/ceedar/issue/CYPACK-1066))
- Added `pathToClaudeCodeExecutable` option to `ClaudeRunnerConfig` in `types.ts`. ([CYPACK-1066](https://linear.app/ceedar/issue/CYPACK-1066))
- Added `TRUSTED_DOMAINS` constant (~200 domains) in `packages/core/src/trusted-domains.ts` matching Claude Code on the web's default allowlist. Added `preset: "trusted"` field to `NetworkPolicySchema`. `EgressProxy.parsePolicy()` expands the preset into `allow` rules, merging any explicit custom rules on top. ([CYPACK-1066](https://linear.app/ceedar/issue/CYPACK-1066))
- Added `WebhookIpValidator` utility to `cyrus-core` (`packages/core/src/security/`) with CIDR matching, known provider IP lists for Linear/GitHub/GitLab, and GitHub `/meta` API refresh support. Each event transport (`LinearEventTransport`, `GitHubEventTransport`, `GitLabEventTransport`) now accepts an optional `ipAllowlist` config and rejects requests from unauthorized IPs with HTTP 403 in signature/direct verification mode. Enabled `trustProxy` on Fastify server for correct `request.ip` behind reverse proxies. ([CYPACK-1056](https://linear.app/ceedar/issue/CYPACK-1056), [#1094](https://github.com/ceedaragents/cyrus/pull/1094))

### Changed
- PR/MR and changelog-update skills now diff changelog entries against the base branch (not the last commit) to detect existing entries added by the current branch. Prevents duplicate entries and ensures existing entries are updated in-place. ([CYPACK-1063](https://linear.app/ceedar/issue/CYPACK-1063), [#1091](https://github.com/ceedaragents/cyrus/pull/1091))
- Replaced `TodoWrite` with granular Task tools (`TaskCreate`, `TaskUpdate`, `TaskGet`, `TaskList`) across all tool allowance lists, prompt templates, and tests. Tool count updated from 30 to 33. Removed `TodoWrite` from `writeTools` (task management is now read-only). Updated system prompt extensions, builder/debugger/scoper prompts, and prompt-template.md to reference Task tools. ([CYPACK-1067](https://linear.app/ceedar/issue/CYPACK-1067), [#1096](https://github.com/ceedaragents/cyrus/pull/1096))
- Removed GitLab-specific changes (IP allowlist for `GitLabEventTransport`, default bot username changes) from tool allowance PR scope. ([CYPACK-1067](https://linear.app/ceedar/issue/CYPACK-1067), [#1096](https://github.com/ceedaragents/cyrus/pull/1096))
- Auth credentials (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_AUTH_TOKEN`) are forwarded from `process.env` to the SDK child process, with `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` set to prevent leakage to Bash subprocesses. Only `PATH` + auth tokens are forwarded from `process.env`; repo `.env` vars and `additionalEnv` are merged separately. ([CYPACK-1066](https://linear.app/ceedar/issue/CYPACK-1066))

## [0.2.44] - 2026-04-10

### Fixed
- `buildAgentContextBlock()` now always emits `<agent_context>` with default bot usernames (`cyrusagent`) instead of returning empty string when `GITHUB_BOT_USERNAME`/`GITLAB_BOT_USERNAME` env vars are unset. Updated `verify-and-ship` skill to also include an explicit fallback instruction. ([CYPACK-1054](https://linear.app/ceedar/issue/CYPACK-1054), [#1082](https://github.com/ceedaragents/cyrus/pull/1082))

## [0.2.43] - 2026-04-08

### Changed
- Introduced `ChatRepositoryProvider` interface and `LiveChatRepositoryProvider` implementation to decouple `SlackChatAdapter` and `ChatSessionHandler` from frozen boot-time repository snapshots. Both now read live repository state on demand at session-build time via the provider abstraction. Removed `chatRepositoryPaths`, `repository`, and `linearWorkspaceId` from `ChatSessionHandlerDeps` in favor of a single `chatRepositoryProvider` field. ([CYPACK-1051](https://linear.app/ceedar/issue/CYPACK-1051), [#1078](https://github.com/ceedaragents/cyrus/pull/1078))

## [0.2.42] - 2026-04-06

### Fixed
- Fixed bundled skills not being included in published npm package. ([CYPACK-1046](https://linear.app/ceedar/issue/CYPACK-1046), [#1073](https://github.com/ceedaragents/cyrus/pull/1073))

## [0.2.41] - 2026-04-06

### Changed
- Replaced rigid procedure-based agent session architecture with skills-based approach. Procedures (ProcedureAnalyzer, subroutine sequencing, validation loop) removed in favor of SKILL.md files delivered via Claude Agent SDK plugin (`cyrus-skills-plugin`). Added `plugins` field to `AgentRunnerConfig`, `ClaudeRunnerConfig`, and `IssueRunnerConfigInput`; wired through `ClaudeRunner` to SDK `query()` options. Added Stop hook to `RunnerConfigBuilder` with `stop_hook_active` guard to ensure PRs/summaries are created before session ends. Simplified `AgentSessionManager` by removing procedure completion routing and validation loop logic. Re-exported `SdkPluginConfig` from `claude-runner`. Removed ~7000 lines of procedure/validation/subroutine code. ([CYPACK-996](https://linear.app/ceedar/issue/CYPACK-996), [#1018](https://github.com/ceedaragents/cyrus/pull/1018))
- Extracted `SkillsPluginResolver` from `EdgeWorker` (SRP refactor). Skills plugin resolution, user plugin manifest auto-scaffolding, and `buildSkillsGuidance()` now live in a dedicated module instead of being inline in the 5400-line EdgeWorker. Removed stale `postProcedureSelectionThought` mocks from 7 test files and updated procedure-referencing comments across source and docs. ([CYPACK-996](https://linear.app/ceedar/issue/CYPACK-996), [#1018](https://github.com/ceedaragents/cyrus/pull/1018))

## [0.2.40] - 2026-04-02

### Changed
- Removed `EdgeWorker.buildMcpConfig()` private wrapper — `RunnerConfigBuilder` and `McpConfigService` now handle all MCP config assembly. Chat sessions (`ChatSessionHandler`) pass `linearWorkspaceId` instead of a pre-built `mcpConfig` object, so `RunnerConfigBuilder.buildChatConfig()` calls `mcpConfigProvider.buildMcpConfig()` fresh per session (same pattern as `buildIssueConfig`). ([CYPACK-1029](https://linear.app/ceedar/issue/CYPACK-1029), [#1063](https://github.com/ceedaragents/cyrus/pull/1063))

## [0.2.39] - 2026-03-31

_No internal changes._

## [0.2.38] - 2026-03-25

### Added
- Created `cyrus-gitlab-event-transport` package mirroring `cyrus-github-event-transport`: `GitLabEventTransport` (webhook endpoint with proxy/signature verification), `GitLabCommentService` (post MR notes, discussion replies, award emoji), `GitLabMessageTranslator` (translate GitLab events to `InternalMessage`), and `gitlab-webhook-utils` (payload extractors). ([#857](https://github.com/ceedaragents/cyrus/issues/857), [#1029](https://github.com/ceedaragents/cyrus/pull/1029))
- Added `GitLabPlatformRef`, `GitLabSessionStartPlatformData`, `GitLabUserPromptPlatformData` types to `cyrus-core` messages. Updated `MessageSource` to include `"gitlab"`. Added type guards `isGitLabMessage`, `hasGitLabSessionStartPlatformData`, `hasGitLabUserPromptPlatformData`. ([#857](https://github.com/ceedaragents/cyrus/issues/857), [#1029](https://github.com/ceedaragents/cyrus/pull/1029))
- Added `gitlabUrl` optional field to `RepositoryConfigSchema` and all JSON schemas. ([#857](https://github.com/ceedaragents/cyrus/issues/857), [#1029](https://github.com/ceedaragents/cyrus/pull/1029))
- Added `glab-mr.md` and `changelog-update-gitlab.md` subroutines mirroring `gh-pr.md` and `changelog-update.md` with `glab` CLI commands. ([#857](https://github.com/ceedaragents/cyrus/issues/857), [#1029](https://github.com/ceedaragents/cyrus/pull/1029))
- Added `applyPlatformSubroutines()` to procedure registry for platform-aware subroutine substitution (swaps `gh-pr` → `glab-mr` and `changelog-update` → `changelog-update-gitlab` for GitLab repos). ([#857](https://github.com/ceedaragents/cyrus/issues/857), [#1029](https://github.com/ceedaragents/cyrus/pull/1029))
- Added `handleCheckGlab` handler to config-updater for checking `glab` CLI installation and authentication. ([#857](https://github.com/ceedaragents/cyrus/issues/857), [#1029](https://github.com/ceedaragents/cyrus/pull/1029))
- Added `registerGitLabEventTransport()`, `handleGitLabWebhook()`, `buildGitLabSystemPrompt()`, `buildGitLabChangeRequestSystemPrompt()`, `postGitLabReply()`, `findRepositoryByGitLabUrl()`, `createGitLabWorkspace()` to EdgeWorker. ([#857](https://github.com/ceedaragents/cyrus/issues/857), [#1029](https://github.com/ceedaragents/cyrus/pull/1029))
- Updated `PromptBuilder.generateRoutingContext()` to include `gitlabUrl` in repo identifiers and XML template. ([#857](https://github.com/ceedaragents/cyrus/issues/857), [#1029](https://github.com/ceedaragents/cyrus/pull/1029))
- Updated `RepositoryRouter` to match `gitlabUrl` in description-tag routing and select signal options. ([#857](https://github.com/ceedaragents/cyrus/issues/857), [#1029](https://github.com/ceedaragents/cyrus/pull/1029))
- Updated `SelfAddRepoCommand` to detect GitLab URLs and set `gitlabUrl` field. ([#857](https://github.com/ceedaragents/cyrus/issues/857), [#1029](https://github.com/ceedaragents/cyrus/pull/1029))
- Created `cyrus-setup-gitlab` skill and updated main setup orchestrator to include GitLab as a surface option. ([#857](https://github.com/ceedaragents/cyrus/issues/857), [#1029](https://github.com/ceedaragents/cyrus/pull/1029))
- Created `docs/GIT_GITLAB.md` documentation. ([#857](https://github.com/ceedaragents/cyrus/issues/857), [#1029](https://github.com/ceedaragents/cyrus/pull/1029))

## [0.2.37] - 2026-03-18

### Added
- Wired user-configured MCP support into Slack chat sessions. `RunnerConfigBuilder.buildChatConfig()` extracts `mcp__*` tool entries from the repository's `allowedTools` config and passes them to `buildChatAllowedTools()`, which merges them with read-only tools and built-in MCP prefixes. `mcpConfigPath` is derived from the repository reference following the `buildIssueConfig()` pattern. `EdgeWorker.registerSlackEventTransport()` passes the first repo to `ChatSessionHandler`, which forwards it to `RunnerConfigBuilder`. ([CYPACK-982](https://linear.app/ceedar/issue/CYPACK-982), [#1006](https://github.com/ceedaragents/cyrus/pull/1006))

### Changed
- Extracted `McpConfigService`, `ToolPermissionResolver`, and `RunnerConfigBuilder` from `EdgeWorker` and `ChatSessionHandler` in `packages/edge-worker`. `McpConfigService` owns MCP server config assembly and cyrus-tools context lifecycle. `ToolPermissionResolver` provides unified tool permission calculation for both issue and chat sessions (fully decoupled from `RunnerSelectionService`). `RunnerConfigBuilder` eliminates duplication between `EdgeWorker.buildAgentRunnerConfig()` and `ChatSessionHandler.buildRunnerConfig()` with `buildIssueConfig()` and `buildChatConfig()` factory methods, depending on focused interfaces (`IChatToolResolver`, `IMcpConfigProvider`, `IRunnerSelector`) instead of concrete classes. `RunnerSelectionService` trimmed to pure runner/model selection (SRP). `ChatSessionHandler` deps simplified to accept `RunnerConfigBuilder` injection. No behavioral changes. ([CYPACK-976](https://linear.app/ceedar/issue/CYPACK-976), [#1003](https://github.com/ceedaragents/cyrus/pull/1003))

## [0.2.36] - 2026-03-17

### Added
- Added `IssueStateChangeMessage` type and `isIssueStateChangeWebhook()` type guard to core types for detecting Linear issue state transitions to `completed` or `canceled`. Added `translateIssueStateChange()` to `LinearMessageTranslator` (checked before title/description updates for priority). Added `GitService.deleteWorktree()` with `findWorktreesUnderPath()` and `isGitWorktree()` helpers supporting both single-repo and multi-repo worktree layouts. Added `handleIssueStateChangeMessage()` to `EdgeWorker` that stops active sessions and deletes worktrees. Added `isIssueStateChangeWebhook` to legacy webhook router (returns early, handled via message bus). 9 new unit tests (4 translator, 5 GitService). ([CYPACK-961](https://linear.app/ceedar/issue/CYPACK-961), [#982](https://github.com/ceedaragents/cyrus/pull/982))
- Added `IssueDeletedWebhook` type and `isIssueDeletedWebhook()` type guard for `Issue/remove` webhooks. Added `translateIssueDeleted()` to `LinearMessageTranslator` that reuses `IssueStateChangeMessage` with `isTerminal: true`. Added early return in EdgeWorker legacy webhook handler for deleted issues. 2 new translator tests. ([CYPACK-961](https://linear.app/ceedar/issue/CYPACK-961), [#982](https://github.com/ceedaragents/cyrus/pull/982))
- `handleIssueStateChangeMessage` now posts a response activity to each stopped session's Linear thread before deleting worktrees, giving users visibility into why the session ended. ([CYPACK-961](https://linear.app/ceedar/issue/CYPACK-961), [#982](https://github.com/ceedaragents/cyrus/pull/982))
- Added `AgentSessionManager.removeSession()` to immediately clean up all session tracking state (sessions, entries, activity sinks, tasks, status activities, stop requests). Called in `handleIssueStateChangeMessage` after posting response activities to prevent stale sessions from being resumed with deleted worktrees. ([CYPACK-961](https://linear.app/ceedar/issue/CYPACK-961), [#982](https://github.com/ceedaragents/cyrus/pull/982))

### Changed
- Made `GitService.workspaceBaseDir` dynamic: replaced the cached string field with a getter that re-reads `CYRUS_WORKTREES_DIR` on every access. Stored `cyrusHome` instead of the resolved path. Updated `Application` to pass `{ cyrusHome }` options object instead of a pre-resolved string. ([CYPACK-961](https://linear.app/ceedar/issue/CYPACK-961), [#982](https://github.com/ceedaragents/cyrus/pull/982))
- Moved `workspaceBaseDir` from a per-call parameter on `GitService.deleteWorktree()` to a constructor-level dependency on `GitService`. Removed repo lookup shim from `handleIssueStateChangeMessage()` — worktree deletion is now keyed solely by the Linear issue identifier from the webhook message. ([CYPACK-961](https://linear.app/ceedar/issue/CYPACK-961), [#982](https://github.com/ceedaragents/cyrus/pull/982))
- Added "Cyrus interaction tip" section to `gh-pr.md` subroutine instructing Claude to include a blockquote tip in PR bodies about bot mentions and "changes requested" reviews. Bot username uses `{{github_bot_username}}` template variable resolved from `GITHUB_BOT_USERNAME` env var (fallback: `cyrusagent`) in `PromptBuilder.loadSubroutinePrompt()`. Added `includeCoAuthoredBy: false` to project `.claude/settings.json` and wrote `.claude/settings.local.json` with the same setting to workspace directories in `EdgeWorker.createCyrusAgentSession()` (loaded via SDK `settingSources: ["local"]`). Updated `docs/GIT_GITHUB.md` to remove co-authored-by references. ([CYPACK-974](https://linear.app/ceedar/issue/CYPACK-974), [#1001](https://github.com/ceedaragents/cyrus/pull/1001))

### Fixed
- Added pnpm overrides to resolve all 36 Dependabot security alerts: bumped `@modelcontextprotocol/sdk` to `>=1.26.0`, `qs` to `>=6.14.2`, added new overrides for `hono>=4.12.7`, `@hono/node-server>=1.19.10`, `rollup>=4.59.0`, `flatted>=3.4.0`, `minimatch>=3.1.4` (with path-specific overrides for `test-exclude`, `nodemon`, `glob` to `>=10.2.3`), `simple-git>=3.32.3`, `undici>=7.24.0`, `ajv>=8.18.0`, `diff>=8.0.3`, `@tootallnate/once>=3.0.1`, `@isaacs/brace-expansion>=5.0.1`. ([CYPACK-973](https://linear.app/ceedar/issue/CYPACK-973), [#1000](https://github.com/ceedaragents/cyrus/pull/1000))
- Fixed worktree not being recreated after terminal state cleanup. The `git worktree list` existence check used substring matching (`includes()`), causing `/path/CYSV-56` to falsely match stale entry `/path/CYSV-56/cyrus`. Changed to exact line-by-line path matching. Added stale worktree validation — if a path is listed in git but has no valid `.git` file on disk, prunes the stale entry and recreates the worktree. Fixed `git worktree remove` in `deleteWorktree()` failing with "not a git repository" by deriving the main repo path from the worktree's `.git` file and passing it as `cwd`. Added post-deletion `git worktree prune` for parent repositories. ([CYPACK-961](https://linear.app/ceedar/issue/CYPACK-961), [#982](https://github.com/ceedaragents/cyrus/pull/982))
- Rewrote `CONTRIBUTING.md` — fixed wrong project name (was "Linear Claude Agent"), wrong license (said MIT, is Apache 2.0), wrong test framework (said Jest, uses Vitest), wrong package manager commands (`npm` → `pnpm`), wrong issue tracker (said GitHub issues, uses Linear), reference to non-existent `.env.example`, and wrong code style guidance (said JSDoc, uses TypeScript). Added monorepo structure, prerequisites, changelog requirements, Biome/Husky tooling, and common commands. ([CYPACK-972](https://linear.app/ceedar/issue/CYPACK-972), [#999](https://github.com/ceedaragents/cyrus/pull/999))
- Registered `-l`/`--label` option with Commander for `self-add-repo` command (was documented but never registered, causing `error: unknown option '-l'`). Fixed idle mode messaging to show `cyrus self-add-repo` guidance for self-hosted users (detected via `LINEAR_CLIENT_ID`) instead of cloud URL. Updated `self-auth` error messages to point to `~/.cyrus/.env` instead of `.zshrc`. Made `self-add-repo` URL argument optional so the interactive prompt ("Repository URL: ") is reachable — `cyrus self-add-repo` with no args now prompts for everything. ([CYPACK-967](https://linear.app/ceedar/issue/CYPACK-967), [#991](https://github.com/ceedaragents/cyrus/pull/991))

## [0.2.35] - 2026-03-16

### Changed
- Renamed `createLinearAgentSession` to `createCyrusAgentSession` and `updateAgentSessionWithClaudeSessionId` to `updateAgentSessionWithRunnerSessionId` in `packages/edge-worker`. Both names were leaky abstractions — the methods are runner-agnostic and handle multiple platforms/runners. ([CYPACK-969](https://linear.app/ceedar/issue/CYPACK-969), [#994](https://github.com/ceedaragents/cyrus/pull/994))
- Threaded `workspaceId` from `webhook.organizationId` (Linear-native source) through EdgeWorker webhook-driven paths, replacing `requireLinearWorkspaceId(repo)` calls. Reduced usage from 45 to 25 calls; remaining calls are only in config/setup paths where repo config is the rightful source. Added optional `workspaceId` to `PromptAssemblyInput`. ([CYPACK-966](https://linear.app/ceedar/issue/CYPACK-966), [#990](https://github.com/ceedaragents/cyrus/pull/990))
- Moved `refreshPromise` from closure variable to instance property in `LinearIssueTrackerService` and clear it in `setAccessToken()` to fix stale token refresh bug. Added `getClient()` method to expose the underlying `LinearClient`. Changed `createCyrusToolsServer()` signature to accept `LinearClient` instead of raw token string, ensuring MCP tools reuse the same client with OAuth refresh interceptor. Updated `EdgeWorker` to pass `LinearClient` from `issueTracker.getClient()` to MCP tool server. Added `-l`/`--label` flag to `SelfAddRepoCommand` for custom routing labels with repo-name default. Based on [grandmore/Cyrus-selfhost#2](https://github.com/grandmore/Cyrus-selfhost/pull/2). ([CYPACK-963](https://linear.app/ceedar/issue/CYPACK-963), [#986](https://github.com/ceedaragents/cyrus/pull/986))

### Fixed
- `LinearEventTransport.handleDirectWebhook()` now uses `request.rawBody` (the original request bytes stashed by `SharedApplicationServer`) for HMAC signature verification instead of `Buffer.from(JSON.stringify(request.body))`. `JSON.stringify` does not guarantee the same byte sequence as the original request, causing intermittent signature failures. Falls back to `JSON.stringify` when `rawBody` is unavailable.
- Bumped `file-type` from 18.7.0 to 21.3.2 ([#983](https://github.com/ceedaragents/cyrus/pull/983))

### Added
- `SelfAuthCommand` now starts a Cloudflare tunnel after OAuth authentication completes, so webhooks can reach the local agent immediately. ([#952](https://github.com/ceedaragents/cyrus/pull/952))

## [0.2.34] - 2026-03-13

### Fixed
- Reworked `handleIssueContentUpdate()` in `EdgeWorker.ts` to be streaming-only: issue update events are now ONLY delivered to currently running sessions via `addStreamMessage()`. Idle sessions are no longer resumed. If the runner doesn't support streaming input, the event is silently ignored. Added webhook deduplication using `createdAt:issueId` composite key with bounded `processedIssueUpdateKeys` set (auto-prunes at 500 entries). Added DEBUG-level logging that traces the webhook key and changed fields for each delivery. Replaced 5 tests with 7 tests in `EdgeWorker.issue-update-multiple-sessions.test.ts`. ([CYPACK-954](https://linear.app/ceedar/issue/CYPACK-954), [#977](https://github.com/ceedaragents/cyrus/pull/977))

### Added
- Added JSON Schema export pipeline for config schemas (`EdgeConfigSchema`, `RepositoryConfigSchema`, etc.) via `pnpm generate:json-schema` in cyrus-core. Generates JSON Schema files in `packages/core/schemas/` using Zod v4's native `.toJSONSchema()`. Includes 16 sync/structure tests, `tsx` devDependency, and a pre-commit hook that blocks commits when `config-schemas.ts` changes without regenerating schemas. ([CYPACK-935](https://linear.app/ceedar/issue/CYPACK-935), [#973](https://github.com/ceedaragents/cyrus/pull/973))

## [0.2.33] - 2026-03-10

### Fixed
- ClaudeRunner now infers `type: "http"` for file-loaded MCP server configs that have a `url` but no `type` discriminator. The Claude Agent SDK requires an explicit `type` field — without it, sessions crash with 0 messages. Codex/Gemini runners are unaffected because they do property-based translation. ([#966](https://github.com/ceedaragents/cyrus/pull/966))

### Changed
- Replaced placeholder `testMcp` handler with actual MCP SDK integration: stdio spawns via `StdioClientTransport`, HTTP/SSE connects via `StreamableHTTPClientTransport`, both perform `tools/list` and return discovered tools. Added `@modelcontextprotocol/sdk` dependency to config-updater and `NodeNext` module resolution. ([#966](https://github.com/ceedaragents/cyrus/pull/966))
- Refactored MCP test handler: fixed `withTimeout` timer leak by clearing setTimeout on settlement, extracted `connectAndDiscover()` to eliminate duplicated connect/list/respond logic, avoided mutating `payload.commandArgs` by copying before sort, added 5s timeout to `client.close()` to prevent zombie stdio processes. ([#966](https://github.com/ceedaragents/cyrus/pull/966))
- MCP config files moved to `~/.cyrus/mcp-configs/` subdirectory; config-updater routes consolidated under `/api/update/` prefix. ([#966](https://github.com/ceedaragents/cyrus/pull/966))
- Restored tab indentation in all package.json files.

## [0.2.32] - 2026-03-10

### Changed
- **Consolidated parent-child session mapping to single source of truth** - Removed redundant `EdgeWorker.childToParentAgentSession` map. `GlobalSessionRegistry` is now the sole owner of parent-child session mappings, eliminating the dual-write obligation that caused the orchestrator result-writing regression. Serialization format (`childToParentAgentSession` key) preserved for backward compatibility. ([CYPACK-922](https://linear.app/ceedar/issue/CYPACK-922), [#957](https://github.com/ceedaragents/cyrus/pull/957))
- Moved `linearToken`, `linearRefreshToken`, and `linearWorkspaceSlug` from per-repository/global config into the `linearWorkspaces` map keyed by Linear workspace ID. `EdgeWorker.issueTrackers` now creates one `IIssueTrackerService` per workspace instead of per repository, eliminating redundant Linear clients. Removed `getIssueTrackerForRepository` wrappers from `EdgeWorker` and `ActivityPoster` — callers now use workspace ID directly. `AttachmentService` accepts workspace ID and resolves tokens internally. Includes idempotent config migration, workspace-level OAuth refresh, and updated CLI commands. ([CYPACK-912](https://linear.app/ceedar/issue/CYPACK-912), [#959](https://github.com/ceedaragents/cyrus/pull/959))
- Updated all `PromptBuilder` methods (`determineSystemPromptFromLabels`, `buildLabelBasedPrompt`, `buildIssueContextPrompt`, `determineBaseBranch`, `hasGraphiteLabel`) to accept `RepositoryConfig[]` instead of a single repository. Multi-repo prompts include per-repo XML sections (`<repositories><repository name="...">`) replacing single-repo `<git_context>`/`<context>` blocks. `determineBaseBranch` returns `Map<string, string>` for per-repo base branches. Label prompt conflict resolution uses first-match-wins with logged warnings. ([CYPACK-919](https://linear.app/ceedar/issue/CYPACK-919), [#964](https://github.com/ceedaragents/cyrus/pull/964))
- Updated `buildAllowedTools()` to compute union across `RepositoryConfig[]` (presets resolved per-repo, then unioned) and `buildDisallowedTools()` to compute intersection (only block if ALL repos block). `buildMcpConfig()` now accepts `RepositoryConfig[]` with workspace-level MCP servers (Linear, cyrus-tools, Slack) configured once per session. Added `buildMergedMcpConfigPath()` to concatenate per-repo `.mcp.json` paths. ([CYPACK-918](https://linear.app/ceedar/issue/CYPACK-918), [#963](https://github.com/ceedaragents/cyrus/pull/963))
- Updated `issueRepositoryCache` from `Map<issueId, string>` to `Map<issueId, string[]>` for multi-repo session support. Routing now returns `RepositoryConfig[]` instead of a single repository. Description tag parsing supports multiple `[repo=...]` tags, label-based routing returns all matching repos, and no-match cases return `needs_selection` instead of a default fallback. Includes cache serialization migration from `Record<string, string>` to `Record<string, string[]>`. ([CYPACK-915](https://linear.app/ceedar/issue/CYPACK-915), [#961](https://github.com/ceedaragents/cyrus/pull/961))

### Added
- GitHub @ mention webhooks on PRs attached to multi-repo Linear issues now resolve the correct sub-worktree for the repository where the mention was triggered. Added `getActiveMultiRepoSessionForRepository()` to `AgentSessionManager` and updated `handleGitHubWebhook()` in `EdgeWorker` to use existing multi-repo workspace paths instead of creating new workspaces. Falls back to root workspace with warning if no sub-worktree is found; single-repo sessions are unchanged. ([CYPACK-920](https://linear.app/ceedar/issue/CYPACK-920), [#965](https://github.com/ceedaragents/cyrus/pull/965))
- `GitService.createGitWorktree()` now accepts `RepositoryConfig[]` and creates the correct folder layout for 0, 1, or N repositories. Added Graphite blocked-by base branch resolution (`determineBaseBranch`, `hasGraphiteLabel`, `fetchBlockingIssues`) directly into `GitService` so worktrees start from the correct base branch without agents needing to rebase. Extended `Workspace` type with `repoPaths` for multi-repo path mapping. ([CYPACK-917](https://linear.app/ceedar/issue/CYPACK-917), [#962](https://github.com/ceedaragents/cyrus/pull/962))
- Added `RepositoryContext` type and `repositories: RepositoryContext[]` field to `CyrusAgentSession`. Each session now explicitly carries its repository context (repositoryId, branchName, baseBranchName). Old sessions without `repositories` default to `[]` on deserialization. ([CYPACK-914](https://linear.app/ceedar/issue/CYPACK-914), [#960](https://github.com/ceedaragents/cyrus/pull/960))
- Consolidated `AgentSessionManager` from a per-repository `Map<string, AgentSessionManager>` to a single instance in `EdgeWorker`. Activity sink resolution moved from constructor-level to per-session via `setActivitySink()`. Serialization format flattened from nested `{[repoId]: {[sessionId]: session}}` to `{[sessionId]: session}` with persistence version bumped 3.0 → 4.0 (backward-compatible migration). ([CYPACK-911](https://linear.app/ceedar/issue/CYPACK-911), [#955](https://github.com/ceedaragents/cyrus/pull/955))

## [0.2.31] - 2026-03-09

### Fixed
- Tests now use `mkdtempSync` for unique per-run temp directories (gemini-runner, cursor-runner, edge-worker), avoiding EACCES on shared `/tmp` and preventing simultaneous test runs from different worktrees from competing for the same folders.
- Added proper handling for `rate_limit_event` messages from Claude runners in `AgentSessionManager` with tiered logging (warn/info/debug by status), and silenced all unhandled informational message types (`rate_limit_event`, `stream_event`, `tool_progress`, `auth_status`, `tool_use_summary`, `prompt_suggestion`) in `ClaudeRunner.processMessage`. ([CYPACK-895](https://linear.app/ceedar/issue/CYPACK-895), [#946](https://github.com/ceedaragents/cyrus/pull/946))

## [0.2.30] - 2026-03-05

### Fixed
- Chat sessions now receive read-only repository path access and explicit `git pull` instructions in their system prompt, with generalized routing context for multi-workspace repositories. ([CYPACK-891](https://linear.app/ceedar/issue/CYPACK-891), [#942](https://github.com/ceedaragents/cyrus/pull/942))

## [0.2.29] - 2026-03-05

### Changed
- Replaced hardcoded runner instantiation in `ChatSessionHandler` with a `createRunner` factory in `ChatSessionHandlerDeps`. Consolidated all runner instantiation in `EdgeWorker` into a single `createRunnerForType` method with exhaustive switch. Resolves model/runner-type mismatch on config hot-reload by moving model resolution into the factory closure. Added `logger` field to `AgentRunnerConfig` to formalize existing usage.
- Extracted `RunnerType` type alias from the Zod `runnerTypeEnum` in `config-schemas.ts` and replaced all hardcoded `"claude" | "gemini" | "codex" | "cursor"` literal unions across `EdgeWorker`, `RunnerSelectionService`, `ProcedureAnalyzer`, and tests.

### Fixed
- `SlackChatAdapter.fetchThreadContext()` no longer filters out the bot's own replies. Follow-up sessions (especially after a runner type change) now retain full conversation history, with the agent's own messages labeled as `"assistant (you)"`.

## [0.2.28] - 2026-03-04

### Added
- Added `resolveVerification()` to `SlackEventTransport` and `GitHubEventTransport` that checks `SLACK_SIGNING_SECRET`/`GITHUB_WEBHOOK_SECRET` env vars (plus `CYRUS_HOST_EXTERNAL`) at request time instead of only at initialization. When started in proxy mode and the relevant env vars are added at runtime, the transport dynamically switches to direct/signature HMAC-SHA256 verification. Both transports now use the same dual-gate (`secret` + `CYRUS_HOST_EXTERNAL`) pattern. Follows the CYPACK-842 pattern of resolving from `process.env` at usage time. Handler methods (`handleDirectWebhook`, `handleProxyWebhook`, `handleSignatureWebhook`) now accept a `secret` parameter from the resolved config. Updated `EdgeWorker.registerGitHubEventTransport()` startup logic to also require `CYRUS_HOST_EXTERNAL` for consistency with Slack. Added "runtime mode switching" test suites to both transport packages. ([CYPACK-884](https://linear.app/ceedar/issue/CYPACK-884), [#934](https://github.com/ceedaragents/cyrus/pull/934))

## [0.2.27] - 2026-03-04

### Added
- Added `getSlackBotToken()` helper to `SlackChatAdapter` that falls back to `process.env.SLACK_BOT_TOKEN` when the event's `slackBotToken` is undefined. Applied across all 4 token-consuming methods (`fetchThreadContext`, `postReply`, `acknowledgeReceipt`, `notifyBusy`). Added explanatory comment in `SlackEventTransport.processAndEmitEvent()` noting the downstream fallback. ([CYPACK-842](https://linear.app/ceedar/issue/CYPACK-842), [#896](https://github.com/ceedaragents/cyrus/pull/896))
- Added `pull_request_review` event type support to `cyrus-github-event-transport`: new `GitHubReview` and `GitHubPullRequestReviewPayload` types, `isPullRequestReviewPayload` type guard, updated `isPullRequestReviewCommentPayload` to disambiguate via `!("review" in payload)`, extended all extractor functions (`extractCommentBody`, `extractCommentAuthor`, `extractCommentId`, `extractCommentUrl`, `extractPRBranchRef`, `extractPRNumber`, `extractPRTitle`, `isCommentOnPullRequest`), and added `translatePullRequestReview`/`translatePullRequestReviewAsUserPrompt` to `GitHubMessageTranslator`. Extended `GitHubEventType` union and `GitHubWebhookEvent.payload` union. Updated `GitHubSessionStartPlatformData` and `GitHubUserPromptPlatformData` `eventType` fields in `cyrus-core`. Added `buildGitHubChangeRequestSystemPrompt` to EdgeWorker with two branches: non-empty review body shows reviewer feedback, empty review body instructs agent to use `gh api` to read PR review comments. Added acknowledgement comment posting via `postIssueComment` before starting agent session. Added defensive `changes_requested` state check. ([CYPACK-842](https://linear.app/ceedar/issue/CYPACK-842), [#896](https://github.com/ceedaragents/cyrus/pull/896))

## [0.2.25] - 2026-02-27

### Fixed
- `RunnerSelectionService` held a stale config reference after `configChanged` hot-reload events. Added `setConfig()` method to `RunnerSelectionService` and wired it into the EdgeWorker's `configChanged` handler alongside `ConfigManager.setConfig()`. Additionally, `ConfigManager.handleConfigChange()` returned early when only global config fields changed (no repository diffs), so `configChanged` was never emitted for changes like `defaultRunner` edits. Added `detectGlobalConfigChanges()` to compare key global fields and emit `configChanged` even when repositories are unchanged. ([#907](https://github.com/ceedaragents/cyrus/pull/907))
- `ProcedureAnalyzer` is now reconstructed when `defaultRunner` changes via hot-reload, since its internal `SimpleRunner` is baked in at construction time. Added debug logging to `resolveDefaultSimpleRunnerType()`. ([#907](https://github.com/ceedaragents/cyrus/pull/907))
- `getDefaultReasoningEffortForModel()` regex `/gpt-5[a-z0-9.-]*codex$/i` only matched `gpt-5.3-codex` etc., not plain `gpt-5` used by ProcedureAnalyzer. Codex CLI defaulted to `xhigh` reasoning effort which `gpt-5` rejects (`unsupported_value`), causing `NoResponseError` during classification. Fixed regex to `/^gpt-5/i`. ([#907](https://github.com/ceedaragents/cyrus/pull/907))
- Added `outputSchema` support to `CodexRunnerConfig` and `CodexRunner.runTurn()`, threaded through to `thread.runStreamed()`. `SimpleCodexRunner` now passes a JSON Schema constraining classification to valid enum values, and `extractResponse()` parses the structured JSON (`{"classification":"code"}`) before falling back to plain text cleaning. ([#907](https://github.com/ceedaragents/cyrus/pull/907))

## [0.2.24] - 2026-02-26

### Fixed
- Added fallback recovery to 4 EdgeWorker webhook handlers (`handleUserPromptedAgentActivity` Branch 3, `handleStopSignal`, `handleIssueUnassignedWebhook`, `handleIssueContentUpdate`) that previously returned silently when `issueRepositoryCache` or session mappings were missing after restart/migration. Prompted webhook now performs 3-tier fallback: search all managers → re-route via `RepositoryRouter.determineRepositoryForWebhook` → post error activity. Stop signal now posts acknowledgment activity via any available manager. Unassignment and issue update handlers now search all `agentSessionManagers` for sessions matching the issue. Warnings downgraded to `info` for expected recovery cases, `warn` reserved for true failures. Added 8 tests in `EdgeWorker.missing-session-recovery.test.ts`. ([CYPACK-852](https://linear.app/ceedar/issue/CYPACK-852), [#905](https://github.com/ceedaragents/cyrus/pull/905))

## [0.2.23] - 2026-02-25

### Fixed
- `WorkerService.ts` was not passing `defaultRunner`, `linearWorkspaceSlug`, `issueUpdateTrigger`, or `promptDefaults` from `edgeConfig` to the `EdgeWorkerConfig` object, causing `EdgeWorker` and `RunnerSelectionService` to always see `undefined` for these fields. Also added `defaultRunner` and `promptDefaults` to `ConfigManager.loadConfigSafely()` merge so config file changes are reflected on hot-reload. Added `CYRUS_DEFAULT_RUNNER` env var support. Added 4 integration tests for `defaultRunner` config in runner selection. ([CYPACK-838](https://linear.app/ceedar/issue/CYPACK-838), [#892](https://github.com/ceedaragents/cyrus/pull/892))

### Added
- Added `gitHubUserId` and `url` to the `User` Pick type in `packages/core/src/issue-tracker/types.ts`, enabling access to Linear users' linked GitHub accounts and profile URLs. Added `resolveGitHubUsername()` method to `PromptBuilder` that resolves numeric GitHub user IDs to usernames via the public GitHub REST API (`GET /user/{id}`). Integrated GitHub username resolution into both `buildLabelBasedPrompt()` and `buildIssueContextPrompt()` flows. Updated `standard-issue-assigned-user-prompt.md` and `label-prompt-template.md` templates to include `<assignee>` context with `<linear_display_name>`, `<linear_profile_url>`, `<github_username>`, `<github_user_id>`, and `<github_noreply_email>` fields—tag names clarify metadata source (Linear vs GitHub). Updated `gh-pr.md` subroutine to instruct agents to add "Assignee: @username" at the top of PR descriptions (GitHub notification), with a fallback to "Assignee: [Display Name](linear_profile_url)" for users without linked GitHub accounts (audit trail). Added `assigneeGitHubUsername` field to `PromptAssemblyInput` type. ([CYPACK-843](https://linear.app/ceedar/issue/CYPACK-843), [#895](https://github.com/ceedaragents/cyrus/pull/895))
- Updated `gh-pr.md` subroutine with optional "Deploy Preview" section at the tail end, referencing any available skill whose "use me when" description refers to creating deploy previews for a branch. This allows agents to optionally set up preview environments to test PRs before merging, using generic language for flexibility and robustness to skill availability changes. ([CYPACK-846](https://linear.app/ceedar/issue/CYPACK-846), [#898](https://github.com/ceedaragents/cyrus/pull/898))

## [0.2.22] - 2026-02-20

### Added
- Added `slack-mcp-server` as a conditional default MCP server in `EdgeWorker.buildMcpConfig()`, gated on the `SLACK_BOT_TOKEN` environment variable. When present, the server is configured via stdio transport (`npx slack-mcp-server@latest --transport stdio`) with the token passed as `SLACK_MCP_XOXB_TOKEN`. `RunnerSelectionService.buildAllowedTools()` conditionally includes `mcp__slack` in the default MCP tools list. Slack MCP is excluded from GitHub sessions via `excludeSlackMcp` option in `buildMcpConfig`/`buildAgentRunnerConfig` and filtered from allowed tools in `handleGitHubWebhook`. ([CYPACK-832](https://linear.app/ceedar/issue/CYPACK-832), [#884](https://github.com/ceedaragents/cyrus/pull/884))
- Added `SimpleCodexRunner` and `SimpleCursorRunner` implementations for constrained-response queries (ProcedureAnalyzer classification). Both follow the same `SimpleAgentRunner<T>` abstract pattern as Claude and Gemini. Added `defaultRunner` field to `EdgeConfigSchema` (flows through to config update endpoint automatically). `RunnerSelectionService.getDefaultRunner()` implements priority: explicit config > single-API-key auto-detect > "claude" fallback. `ProcedureAnalyzer` now supports all 4 runner types with runner-specific default models. Pinned zod to 4.3.6 via pnpm overrides to eliminate dual-version type incompatibility that blocked cross-package type resolution. Deleted obsolete `codex-runner-shim.d.ts`. Changed `SDKMessage` imports in `simple-agent-runner` from `@anthropic-ai/claude-agent-sdk` to `cyrus-core` to avoid cross-package type conflicts. ([CYPACK-826](https://linear.app/ceedar/issue/CYPACK-826), [#878](https://github.com/ceedaragents/cyrus/pull/878))

### Changed
- Moved GPT Image and Sora video generation tools from `cyrus-claude-runner` to `cyrus-mcp-tools`, integrating them into the `cyrus-tools` MCP server via `registerImageTools()`/`registerSoraTools()`. Converted from `@anthropic-ai/claude-agent-sdk` `tool()`/`createSdkMcpServer()` pattern to `@modelcontextprotocol/sdk` `server.registerTool()` pattern. API key now sourced from `process.env.OPENAI_API_KEY` instead of `repository.openaiApiKey` config. Removed `openaiApiKey` and `openaiOutputDirectory` from `RepositoryConfigSchema`. Removed `openai` dependency from `cyrus-claude-runner`, added to `cyrus-mcp-tools`. Removed separate `image-tools` and `sora-tools` MCP server creation from EdgeWorker's `buildMcpConfig()`. ([CYPACK-831](https://linear.app/ceedar/issue/CYPACK-831), [#883](https://github.com/ceedaragents/cyrus/pull/883))
- Updated `@anthropic-ai/claude-agent-sdk` to v0.2.47 and `@anthropic-ai/sdk` to v0.77.0. Added `speed` field to `BetaUsage` objects in codex-runner and gemini-runner, added type annotations for `ContentBlock` filters in claude-runner to resolve TypeScript inference issues with updated SDK types. ([CYPACK-827](https://linear.app/ceedar/issue/CYPACK-827), [#880](https://github.com/ceedaragents/cyrus/pull/880))
- `SlackEventTransport.getSlackBotToken()` now reads `SLACK_BOT_TOKEN` exclusively from `process.env` with no header fallback. The `X-Slack-Bot-Token` request header is no longer used. ([CYPACK-824](https://linear.app/ceedar/issue/CYPACK-824), [#876](https://github.com/ceedaragents/cyrus/pull/876))
- Refactored `EdgeWorker.ts` by extracting 5 service modules: `ActivityPoster` (Linear activity posting), `AttachmentService` (attachment download/manifests), `ConfigManager` (config file watching/reload/change detection), `PromptBuilder` (prompt assembly/system prompts/issue context), and `RunnerSelectionService` (runner/model selection/tool configuration). Reduced EdgeWorker from 7,687 to 5,466 lines (29% reduction) while maintaining full test coverage (522 tests). ([CYPACK-822](https://linear.app/ceedar/issue/CYPACK-822), [#874](https://github.com/ceedaragents/cyrus/pull/874))
- Merged `main` into `cypack-807` branch, resolving 7 merge conflicts and fixing auto-merge issues across AgentSessionManager, EdgeWorker, GitService, ProcedureAnalyzer, gemini-runner, and changelogs. Updated 2 test files from `IIssueTrackerService` to `IActivitySink` interface. ([CYPACK-821](https://linear.app/ceedar/issue/CYPACK-821), [#873](https://github.com/ceedaragents/cyrus/pull/873))
- Decoupled Slack webhook handler from `RepositoryConfig`: introduced `NoopActivitySink` for non-repository sessions, dedicated `slackSessionManager` on `EdgeWorker`, and `slackThreadSessions` map for thread-based session reuse. `createSlackWorkspace` now creates plain directories under `~/.cyrus/slack-workspaces/` instead of git worktrees. Runner config is built inline (bypassing `buildAgentRunnerConfig` which requires a repository). Added `SlackReactionService` to `cyrus-slack-event-transport` package. ([CYPACK-815](https://linear.app/ceedar/issue/CYPACK-815), [#868](https://github.com/ceedaragents/cyrus/pull/868))
- Refactored logging across all packages to use a dedicated `ILogger` interface and `Logger` implementation in `packages/core/src/logging/`. Replaced direct `console.log`/`console.error` calls in EdgeWorker, AgentSessionManager, ClaudeRunner, GitService, RepositoryRouter, SharedApplicationServer, SharedWebhookServer, WorktreeIncludeService, ProcedureAnalyzer, AskUserQuestionHandler, LinearEventTransport, and LinearIssueTrackerService with structured logger calls. Log level is configurable via the `CYRUS_LOG_LEVEL` environment variable (DEBUG, INFO, WARN, ERROR, SILENT).
- Added source context (session ID, platform, issue identifier, repository) to log messages via `logger.withContext()`, enabling easier debugging and log filtering across concurrent sessions
- Updated `CyrusAgentSession` schema to v3.0: renamed `linearAgentActivitySessionId` to `id`, added optional `externalSessionId` for tracker-specific IDs, added optional `issueContext` object for issue metadata, made `issue` and `issueId` optional to support standalone sessions ([CYPACK-728](https://linear.app/ceedar/issue/CYPACK-728), [#770](https://github.com/ceedaragents/cyrus/pull/770))
- Updated `PersistenceManager` to v3.0 format with automatic migration from v2.0, preserving all existing session data during migration ([CYPACK-728](https://linear.app/ceedar/issue/CYPACK-728), [#770](https://github.com/ceedaragents/cyrus/pull/770))
- GitHub webhook handling now uses forwarded installation tokens: `GitHubEventTransport` extracts `X-GitHub-Installation-Token` header from CYHOST webhooks and includes it in emitted events, `EdgeWorker.postGitHubReply()` and `EdgeWorker.fetchPRBranchRef()` prefer the forwarded token over `process.env.GITHUB_TOKEN`, enabling self-hosted Cyrus instances to post PR comment replies and fetch PR branch details using short-lived (1-hour) GitHub App installation tokens ([CYPACK-773](https://linear.app/ceedar/issue/CYPACK-773), [#821](https://github.com/ceedaragents/cyrus/pull/821), [CYPACK-774](https://linear.app/ceedar/issue/CYPACK-774), [#822](https://github.com/ceedaragents/cyrus/pull/822))

### Added
- New `cyrus-slack-event-transport` package: EventEmitter-based transport for receiving and verifying forwarded Slack webhooks from CYHOST, with proxy (Bearer token) verification mode. Includes `SlackMessageTranslator` for translating `app_mention` events into unified `SessionStartMessage` and `UserPromptMessage` types, thread-aware session key generation (`channel:thread_ts`), `@mention` stripping, and Slack Bot token forwarding via `X-Slack-Bot-Token` header. Added `SlackSessionStartPlatformData`, `SlackUserPromptPlatformData`, and corresponding type guards to `cyrus-core`. ([CYPACK-807](https://linear.app/ceedar/issue/CYPACK-807), [#861](https://github.com/ceedaragents/cyrus/pull/861))
- New `cyrus-github-event-transport` package: EventEmitter-based transport for receiving and verifying forwarded GitHub webhooks, with proxy (Bearer token) and signature (HMAC-SHA256) verification modes, a `GitHubCommentService` for posting replies via GitHub REST API, and utility functions for extracting webhook payload data. ([CYPACK-772](https://linear.app/ceedar/issue/CYPACK-772), [#820](https://github.com/ceedaragents/cyrus/pull/820))
- EdgeWorker GitHub webhook integration: `/github-webhook` endpoint, session creation flow for PR comments, git worktree checkout for PR branches, and reply posting via GitHub API. ([CYPACK-772](https://linear.app/ceedar/issue/CYPACK-772), [#820](https://github.com/ceedaragents/cyrus/pull/820))
- Subroutine result text is now stored in procedure history when advancing between subroutines. On error results (e.g. `error_max_turns` from single-turn subroutines), `AgentSessionManager` recovers by using the last completed subroutine's result via `ProcedureAnalyzer.getLastSubroutineResult()`, allowing the procedure to continue to completion instead of failing
- Created `GlobalSessionRegistry` class for centralized session storage across all repositories, enabling cross-repository session lookups in orchestrator workflows ([CYPACK-725](https://linear.app/ceedar/issue/CYPACK-725), [#766](https://github.com/ceedaragents/cyrus/pull/766))
- Extracted `IActivitySink` interface and `LinearActivitySink` implementation to decouple activity posting from `IIssueTrackerService`, enabling multiple activity sinks to receive session activities ([CYPACK-726](https://linear.app/ceedar/issue/CYPACK-726), [#767](https://github.com/ceedaragents/cyrus/pull/767))
- Integrated `GlobalSessionRegistry` with `EdgeWorker`, making it the single source of truth for parent-child session mappings and cross-repository session lookups ([CYPACK-727](https://linear.app/ceedar/issue/CYPACK-727), [#769](https://github.com/ceedaragents/cyrus/pull/769))
- Added Cursor harness `[agent=cursor]`, including offline F1 drives for stop/tool activity, resume continuation, and permission synchronization behavior. Also added project-level Cursor CLI permissions mapping from Cyrus tool permissions (including subroutine-time updates), pre-run MCP server enablement (`agent mcp list` + `agent mcp enable <server>`), switched the default Codex runner model to `gpt-5.3-codex`, and aligned edge-worker Vitest module resolution to use local `cyrus-claude-runner` sources during tests. ([CYPACK-804](https://linear.app/ceedar/issue/CYPACK-804), [#858](https://github.com/ceedaragents/cyrus/pull/858))
- Added Fastify MCP transport for `cyrus-tools` on the shared application server endpoint, replacing inline SDK-only wiring with HTTP MCP configuration and per-session context headers, and now enforcing `Authorization: Bearer <CYRUS_API_KEY>` on `/mcp/cyrus-tools` requests. Also fixed Codex MCP server config mapping so `headers` are translated to Codex `http_headers` (while preserving `http_headers`, `env_http_headers`, and `bearer_token_env_var`) for authenticated HTTP MCP initialization. Includes F1 validation covering `initialize` and `tools/list` on `/mcp/cyrus-tools`. ([CYPACK-817](https://linear.app/ceedar/issue/CYPACK-817), [#870](https://github.com/ceedaragents/cyrus/pull/870))

### Fixed
- Updated orchestrator system prompts to explicitly require `state: "To Do"` when creating issues via `mcp__linear__create_issue`, preventing issues from being created in "Triage" status. ([CYPACK-761](https://linear.app/ceedar/issue/CYPACK-761), [#815](https://github.com/ceedaragents/cyrus/pull/815))

## [0.2.21] - 2026-02-09

### Changed
- Refactored formatting strategy from TodoWrite to Task tools (TaskCreate, TaskUpdate, TaskList, TaskGet). Added `formatTaskParameter()` method to IMessageFormatter interface and updated AgentSessionManager to handle Task tools as thought activities. ([CYPACK-788](https://linear.app/ceedar/issue/CYPACK-788), [#837](https://github.com/ceedaragents/cyrus/pull/837))
- Redesigned TaskCreate formatting for parallel execution (concise `⏳ **subject**` checklist items), improved TaskUpdate/TaskGet to show subject names with status emojis, added ToolSearch formatting (`🔍 Loading`/`🔍 Searching tools`) rendered as non-ephemeral thought in AgentSessionManager, and added TaskOutput formatting (`📤 Waiting for`/`📤 Checking`). Updated both ClaudeMessageFormatter and GeminiMessageFormatter with matching logic. ([CYPACK-795](https://linear.app/ceedar/issue/CYPACK-795), [#846](https://github.com/ceedaragents/cyrus/pull/846))
- Deferred TaskUpdate/TaskGet activity posting from tool_use time to tool_result time to enrich with task subject. Added `taskSubjectsByToolUseId` and `taskSubjectsById` caches to AgentSessionManager for subject resolution from TaskCreate results and TaskGet result parsing. ([CYPACK-797](https://linear.app/ceedar/issue/CYPACK-797), [#847](https://github.com/ceedaragents/cyrus/pull/847))

### Added
- Subroutine result text is now stored in procedure history when advancing between subroutines. On error results (e.g. `error_max_turns` from single-turn subroutines), `AgentSessionManager` recovers by using the last completed subroutine's result via `ProcedureAnalyzer.getLastSubroutineResult()`, allowing the procedure to continue to completion instead of failing. Added `disallowAllTools` parameter to `buildAgentRunnerConfig` and `tools` config pass-through to `ClaudeRunner` for properly disabling built-in tools. ([CYPACK-792](https://linear.app/ceedar/issue/CYPACK-792), [#843](https://github.com/ceedaragents/cyrus/pull/843))

## [0.2.20] - 2026-02-05

(No internal changes in this release)

## [0.2.19] - 2026-01-24

### Fixed
- Fixed labelPrompts schema to accept both simple array form (`{ debugger: ["Bug"] }`) and complex object form (`{ debugger: { labels: ["Bug"], allowedTools?: ... } }`). This resolves type mismatches when cyrus-hosted sends simplified configurations. ([#802](https://github.com/ceedaragents/cyrus/pull/802))

## [0.2.18] - 2026-01-23

### Changed
- Replaced manual TypeScript interfaces with Zod schemas as the source of truth for `EdgeConfig`, `RepositoryConfig`, and related configuration types. This ensures type safety at both compile-time and runtime, and fixes type drift where `CyrusConfigPayload` was missing fields like `issueUpdateTrigger`. ([#800](https://github.com/ceedaragents/cyrus/pull/800))

## [0.2.17] - 2026-01-23

(No internal changes in this release)

## [0.2.16] - 2026-01-23

(No internal changes in this release)

## [0.2.15] - 2026-01-16

(No internal changes in this release)

## [0.2.14] - 2026-01-16

(No internal changes in this release)

## [0.2.13] - 2026-01-15

(No internal changes in this release)

## [0.2.12] - 2026-01-09

(No internal changes in this release)

## [0.2.11] - 2026-01-07

(No internal changes in this release)

## [0.2.10] - 2026-01-06

(No internal changes in this release)

## [0.2.9] - 2025-12-30

(No internal changes in this release)

## [0.2.8] - 2025-12-28

(No internal changes in this release)

## [0.2.7] - 2025-12-28

### Changed
- Moved publishing docs from CLAUDE.md to `/release` skill for cleaner documentation and easier invocation ([CYPACK-667](https://linear.app/ceedar/issue/CYPACK-667), [#705](https://github.com/ceedaragents/cyrus/pull/705))

## [0.2.6] - 2025-12-22

### Fixed
- Fixed the CLI issue tracker's `labels()` method to return actual label data instead of an empty array, enabling correct runner selection (Codex/Gemini) in F1 tests ([CYPACK-547](https://linear.app/ceedar/issue/CYPACK-547), [#624](https://github.com/ceedaragents/cyrus/pull/624))
