# Internal Changelog

This changelog documents internal development changes, refactors, tooling updates, and other non-user-facing modifications.

## [Unreleased]

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
