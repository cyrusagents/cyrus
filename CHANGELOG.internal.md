# Internal Changelog

This changelog documents internal development changes, refactors, tooling updates, and other non-user-facing modifications.

## [Unreleased]

### Added
- Added `SimpleCodexRunner` and `SimpleCursorRunner` implementations for constrained-response queries (ProcedureAnalyzer classification). Both follow the same `SimpleAgentRunner<T>` abstract pattern as Claude and Gemini. Added `defaultRunner` field to `EdgeConfigSchema` (flows through to config update endpoint automatically). `RunnerSelectionService.getDefaultRunner()` implements priority: explicit config > single-API-key auto-detect > "claude" fallback. `ProcedureAnalyzer` now supports all 4 runner types with runner-specific default models. Pinned zod to 4.3.6 via pnpm overrides to eliminate dual-version type incompatibility that blocked cross-package type resolution. Deleted obsolete `codex-runner-shim.d.ts`. Changed `SDKMessage` imports in `simple-agent-runner` from `@anthropic-ai/claude-agent-sdk` to `cyrus-core` to avoid cross-package type conflicts. ([CYPACK-826](https://linear.app/ceedar/issue/CYPACK-826), [#878](https://github.com/ceedaragents/cyrus/pull/878))

### Changed
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
