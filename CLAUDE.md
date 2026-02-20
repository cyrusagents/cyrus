# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Cyrus (Linear Claude Agent) is a monorepo JavaScript/TypeScript application that integrates Linear's issue tracking with Anthropic's Claude Code to automate software development tasks. The project is transitioning to an edge-proxy architecture that separates OAuth/webhook handling (proxy) from Claude processing (edge workers).

**Key capabilities:**
- Monitors Linear issues assigned to a specific user
- Creates isolated Git worktrees for each issue
- Runs Claude Code sessions to process issues
- Posts responses back to Linear as comments
- Maintains conversation continuity using the `--continue` flag
- Supports edge worker mode for distributed processing


## How Cyrus Works

When a Linear issue is assigned to Cyrus, the following sequence occurs:

1. **Issue Detection & Routing**: The EdgeWorker receives a webhook from Linear and routes the issue to the appropriate repository based on configured patterns or workspace catch-all rules.

2. **Workspace Isolation**: A dedicated Git worktree is created for each issue (e.g., `worktrees/DEF-1/`) with a sanitized branch name derived from the issue identifier. This ensures complete isolation between concurrent tasks.

3. **AI Classification**: The issue content is analyzed to determine its type (`code`, `question`, `research`, etc.) and the appropriate procedure is selected (e.g., `full-development` for coding tasks).

4. **Subroutine Execution**: For development tasks, Claude executes a sequence of subroutines:
   - **coding-activity**: Implements the requested feature/fix
   - **verifications**: Runs tests, type checks, and linting
   - **git-gh**: Commits changes and creates pull requests
   - **concise-summary**: Generates a final summary for Linear

5. **Mid-Implementation Prompting**: Users can add comments to the Linear issue while Claude is working. These comments are streamed into the active session, allowing real-time guidance (e.g., "Also add a modulo method while you're at it").

6. **Activity Tracking**: Every thought and action is posted back to Linear as activities, providing full visibility into what Claude is doing.

### Example Interaction

A typical session flow:
```
[GitService] Fetching latest changes from remote...
[GitService] Creating git worktree at .../worktrees/DEF-1 from origin/main
[EdgeWorker] Workspace created at: .../worktrees/DEF-1
[EdgeWorker] AI routing decision: Classification: code, Procedure: full-development
[ClaudeRunner] Session ID assigned by Claude: c5c1fc00-...
[AgentSessionManager] Created thought activity activity-6
[AgentSessionManager] Created action activity activity-7
... (Claude implements the feature)
[ClaudeRunner] Session completed with 84 messages
[AgentSessionManager] Subroutine completed, advancing to next: verifications
```

### Test Drives

To see Cyrus in action, refer to the test drives in `apps/f1/test-drives/`. These documents showcase real interactions demonstrating:
- How issues are processed end-to-end
- Mid-implementation prompting in action
- Subroutine transitions and activity logging
- Final repository state after completion

The F1 (Formula 1) testing framework provides a controlled environment to test Cyrus without affecting production Linear workspaces.

CRITICAL: you must use the f1 test drive protocol during the 'testing and validation' stage of any major work undertaking. You CAN also use it in development situations where you want to test drive the version of the product that you're working on.

## Linear Webhooks Reference

Cyrus processes Linear webhooks to respond to events like issue assignments, user prompts, and issue updates. The Linear SDK and webhook schemas are documented at:

- **EntityWebhookPayload**: https://studio.apollographql.com/public/Linear-Webhooks/variant/current/schema/reference/objects/EntityWebhookPayload
- **DataWebhookPayload**: https://studio.apollographql.com/public/Linear-Webhooks/variant/current/schema/reference/unions/DataWebhookPayload
- **IssueWebhookPayload**: https://studio.apollographql.com/public/Linear-Webhooks/variant/current/schema/reference/objects/IssueWebhookPayload

Key webhook types handled:
- `AgentSessionEvent` (created/prompted) - When issues are assigned to Cyrus or users send prompts
- `AppUserNotification` (issueUnassignedFromYou) - When issues are unassigned
- `Issue` (update with title/description changes) - When issue title or description is modified

The `EntityWebhookPayload` contains an `updatedFrom` field that holds previous values of changed properties, enabling Cyrus to detect what changed and compare old vs new values.

## Working with SDKs

When examining or working with a package SDK:

1. First, install the dependencies:
   ```bash
   pnpm install
   ```

2. Locate the specific SDK in the `node_modules` directory to examine its structure, types, and implementation details.

3. Review the SDK's documentation, source code, and type definitions to understand its API and usage patterns.

## Shared Skills Across Harnesses

For reusable operational workflows (for example F1 test driving), keep a canonical skill in:

- `skills/<skill-name>/SKILL.md`

Then symlink that skill into harness-specific skill directories:

- `.claude/skills/<skill-name>`
- `.codex/skills/<skill-name>`
- `.opencode/skills/<skill-name>`

Use:

```bash
./scripts/symlink-skills.sh
```

Design rule:

1. Keep subagent files thin wrappers.
2. Put 95%+ workflow logic into canonical shared skills.
3. Update shared skill first; avoid duplicating protocol text across harnesses.

## Checklist For New Agent CLI Harnesses

When implementing a new runner/harness (for example Codex, Gemini, OpenCode, or other CLIs), use this checklist before shipping.

### 1) Session Lifecycle And Turn Limits

- Verify turn-limit behavior (`maxTurns`, `maxSessionTurns`, or equivalent).
- Confirm what error/result payload is emitted when limits are exceeded.
- Ensure session stop behavior is explicit and deterministic.

### 2) Prompt Model And Instructions

- Identify how base system prompt is applied.
- Identify whether appended instructions are supported and whether they extend or replace defaults.
- Confirm provider-specific instruction fields (for example `developer_instructions`) and expected precedence.

### 3) Streaming Event Schema

- Capture real JSON event streams and document item types.
- Determine whether events are full objects or deltas/partials that require aggregation.
- Add replay tests from real transcripts.

### 4) Final Message Semantics

- Verify where the final answer lives:
  - in a `result` payload (Claude-style), or
  - in the last assistant message (Gemini-style), or
  - mixed model/event behavior.
- Ensure we always post a final `response` activity when work completes successfully.

### 5) Tools And Permissions

- Validate `tools`, `allowedTools`, and `disallowedTools` semantics for the SDK.
- Validate approval/sandbox behavior for tool execution.
- Verify tool calls produce both start and completion signals.
- For providers that rely on static/project config files (for example Cursor CLI), implement a permission translation layer from Cyrus/Claude tool names to provider-native permission tokens and write that config before session start. This must support subroutine-time updates when allowed/disallowed tools change. For Cursor MCP servers, pre-enable them before session start (`agent mcp list` + `agent mcp enable <server>` per server) so tools are available in headless runs. When using Cursor in Cyrus, only MCP servers configured in `.cursor/mcp.json` should be treated as project MCP config; use Cursor's MCP config-location and file-format docs as the source of truth: https://cursor.com/docs/context/mcp#configuration-locations. For broad file permissions, map wildcard `Read(**)` / `Write(**)` to workspace-scoped patterns (for example `Read(./**)` / `Write(./**)`) to avoid unintentionally permitting absolute system paths. Reference: https://cursor.com/docs/cli/reference/permissions

### 6) Prompt Streaming Input

- Verify whether the SDK supports streaming/incremental prompt input.
- Set `supportsStreamingInput` correctly and gate behavior in runner adapters.

### 7) MCP Servers And Custom Tools

- Verify MCP server config format and merge behavior.
- Verify custom tool registration/invocation behavior.
- Ensure MCP/custom-tool events are mapped into consistent runner message shapes.

### 8) Runner Selection Via Labels And Description Selectors

- Keep agent label and model label separate (example: `codex` and `gpt-5-codex`).
- Support issue description selectors like `[agent=...]`, `[model=...]`, `[repo=...]`.
- Add precedence tests for labels vs selectors vs repository defaults.

### 9) Activity Formatting And Timeline Visibility

- Ensure formatter output is timeline-ready (AgentActivity content fields).
- Ensure tool lifecycle events are visible as activities (not silently dropped).
- Use Markdown-compatible formatting for checklists:
  - `- [ ] item`
  - `- [x] item`

### 10) Usage, Stop Reasons, And Typing

- Map usage/cost/stop-reason fields to expected shared types.
- Fill required compatibility fields even when provider omits them natively.
- Keep strict TypeScript compatibility for cross-runner shared contracts.

### 11) Config Schema And Backward Compatibility

- Use provider-specific defaults (`claudeDefaultModel`, `geminiDefaultModel`, `codexDefaultModel`).
- Add config migration logic for renamed or legacy fields.
- Keep docs/comments provider-specific and explicit.

### 12) Validation Protocol Before Merge

- Run unit tests for new runner adapters and formatter behavior.
- Run replay tests from real CLI transcripts.
- Validate F1 end-to-end scenarios for:
  - label-based runner/model selection
  - description selector-based runner/model selection
  - visible tool/file-edit activities in session timeline
  - final response posting behavior

### Codex Integration Lesson Learned

Codex emitted tool activity at `item.started`/`item.completed` events, but those were initially not mapped to `tool_use`/`tool_result`. The result was missing action/file-edit visibility in Linear. For any new harness, treat tool lifecycle mapping as a first-class acceptance criterion, not a formatter-only concern.

### Cursor Integration Lesson Learned

Cursor CLI permissions are enforced from config (`~/.cursor/cli-config.json` or `<project>/.cursor/cli.json`) instead of dynamic per-request tool allowlists. For Cursor-like providers, do not rely on dynamic SDK tool constraints alone—add a translation layer (for example `mcp__server__tool` -> `Mcp(server:tool)`, `Bash(...)` -> `Shell(...)`) and sync project permissions before each run and between subroutines. Also pre-enable MCP servers via `agent mcp list` + `agent mcp enable <server>` using both project-listed and runner-configured server names so headless sessions can invoke MCP tools immediately. In Cyrus Cursor runs, treat `.cursor/mcp.json` as the project MCP source and follow Cursor's configuration-location and file-syntax docs (these differ from Claude's MCP interpretation): https://cursor.com/docs/context/mcp#configuration-locations. Use workspace-scoped wildcard file permissions (`Read(./**)`, `Write(./**)`) rather than unscoped `Read(**)` / `Write(**)` in translation defaults. Reference: https://cursor.com/docs/cli/reference/permissions

## Navigating GitHub Repositories

When you need to examine source code from GitHub repositories (especially when GitHub's authentication blocks normal navigation):

**Use uuithub.com instead of github.com:**

```
# Instead of:
https://github.com/google-gemini/gemini-cli/blob/main/src/file.ts

# Use:
https://uuithub.com/google-gemini/gemini-cli/blob/main/src/file.ts
```

This proxy service provides unauthenticated access to GitHub content, making it ideal for:
- Reading source code files
- Browsing directory structures
- Examining schemas and configuration files
- Investigating third-party library implementations

Simply replace `github.com` with `uuithub.com` in any GitHub URL.

## Architecture Overview

The codebase follows a pnpm monorepo structure:

```
cyrus/
├── apps/
│   ├── cli/          # Main CLI application
│   ├── electron/     # Future Electron GUI (in development)
│   └── proxy/        # Edge proxy server for OAuth/webhooks
└── packages/
    ├── core/         # Shared types and session management
    ├── claude-parser/# Claude stdout parsing with jq
    ├── claude-runner/# Claude CLI execution wrapper
    ├── edge-worker/  # Edge worker client implementation
    └── ndjson-client/# NDJSON streaming client
```

For a detailed visual representation of how these components interact and map Claude Code sessions to Linear comment threads, see @architecture.md.

## Testing Best Practices

### Prompt Assembly Tests

When working with prompt assembly tests in `packages/edge-worker/test/prompt-assembly*.test.ts`:

**CRITICAL: Always assert the ENTIRE prompt, never use partial checks like `.toContain()`**

- Use `.expectUserPrompt()` with the complete expected prompt string
- Use `.expectSystemPrompt()` with the complete expected system prompt (or `undefined`)
- Use `.expectComponents()` to verify all prompt components
- Use `.expectPromptType()` to verify the prompt type
- Always call `.verify()` to execute all assertions

This ensures comprehensive test coverage and catches regressions in prompt structure, formatting, and content. Partial assertions with `.toContain()` are too weak and can miss important changes.

**Example**:
```typescript
// ✅ CORRECT - Full prompt assertion
await scenario(worker)
  .newSession()
  .withUserComment("Test comment")
  .expectUserPrompt(`<user_comment>
  <author>Test User</author>
  <timestamp>2025-01-27T12:00:00Z</timestamp>
  <content>
Test comment
  </content>
</user_comment>`)
  .expectSystemPrompt(undefined)
  .expectPromptType("continuation")
  .expectComponents("user-comment")
  .verify();

// ❌ INCORRECT - Partial assertion (too weak)
const result = await scenario(worker)
  .newSession()
  .withUserComment("Test comment")
  .build();
expect(result.userPrompt).toContain("<user_comment>");
expect(result.userPrompt).toContain("Test User");
```

## Common Commands

### Monorepo-wide Commands (run from root)
```bash
# Install dependencies for all packages
pnpm install

# Build all packages
pnpm build

# Build lint for the entire repository
pnpm lint

# Run tests across all packages
pnpm test

# Run tests only in packages directory (recommended)
pnpm test:packages:run

# Run TypeScript type checking
pnpm typecheck

# Development mode (watch all packages)
pnpm dev
```

### App-specific Commands

#### CLI App (`apps/cli/`)
```bash
# Start the agent
pnpm start

# Development mode with auto-restart
pnpm dev

# Run tests
pnpm test
pnpm test:watch  # Watch mode

# Local development setup (link development version globally)
pnpm build                    # Build all packages first
pnpm uninstall cyrus-ai -g    # Remove published version
cd apps/cli                   # Navigate to CLI directory
pnpm install -g .            # Install local version globally
pnpm link -g .               # Link local development version
```

#### Electron App (`apps/electron/`)
```bash
# Development mode
pnpm dev

# Build for production
pnpm build:all

# Run electron in dev mode
pnpm electron:dev
```

#### Proxy App (`apps/proxy/`)
```bash
# Start proxy server
pnpm start

# Development mode with auto-restart
pnpm dev

# Run tests
pnpm test
```

### Package Commands (all packages follow same pattern)
```bash
# Build the package
pnpm build

# TypeScript type checking
pnpm typecheck

# Run tests
pnpm test        # Watch mode
pnpm test:run    # Run once

# Development mode (TypeScript watch)
pnpm dev
```

## Linear State Management

The agent automatically moves issues to the "started" state when assigned. Linear uses standardized state types:

- **State Types Reference**: https://studio.apollographql.com/public/Linear-API/variant/current/schema/reference/enums/ProjectStatusType
- **Standard Types**: `triage`, `backlog`, `unstarted`, `started`, `completed`, `canceled`
- **Issue Assignment Behavior**: When an issue is assigned to the agent, it automatically transitions to a state with `type === 'started'` (In Progress)

## Important Development Notes

1. **Edge-Proxy Architecture**: The project is transitioning to separate OAuth/webhook handling from Claude processing.

2. **Dependencies**: 
   - The claude-parser package requires `jq` to be installed on the system
   - Uses pnpm as package manager (v10.11.0)
   - TypeScript for all new packages

3. **Git Worktrees**: When processing issues, the agent creates separate git worktrees. If a `cyrus-setup.sh` script exists in the repository root, it's executed in new worktrees for project-specific initialization.

4. **Testing**: Uses Vitest for all packages. Run tests before committing changes.

## Development Workflow

When working on this codebase, follow these practices:

1. **As part of submitting a Pull Request**:
   - Update `CHANGELOG.md` under the `## [Unreleased]` section with your changes
   - Use appropriate subsections: `### Added`, `### Changed`, `### Fixed`, `### Removed`
   - Include brief, clear descriptions of what was changed and why
   - **Include the PR number/link**: If the PR is already created, include the link (e.g., `([#123](https://github.com/ceedaragents/cyrus/pull/123))`). If not, create the PR first, then update the changelog with the link, commit, and push.
   - Run `pnpm test:packages` to ensure all package tests pass
   - Run `pnpm typecheck` to verify TypeScript compilation
   - Consider running `pnpm build` to ensure the build succeeds

2. **Internal Changelog**:
   - For internal development changes, refactors, tooling updates, or other non-user-facing modifications, update `CHANGELOG.internal.md`.
   - Follow the same format as the main changelog.
   - This helps track internal improvements that don't need to be exposed to end-users.

3. **Changelog Format**:
   - Follow [Keep a Changelog](https://keepachangelog.com/) format
   - **Focus only on end-user impact**: Write entries from the perspective of users running the `cyrus` CLI binary
   - Avoid technical implementation details, package names, or internal architecture changes
   - Be concise but descriptive about what users will experience differently
   - Group related changes together
   - Example: "New comments now feed into existing sessions" NOT "Implemented AsyncIterable<SDKUserMessage> for ClaudeRunner"

## Key Code Paths

- **Linear Integration**: `apps/cli/services/LinearIssueService.mjs`
- **Claude Execution**: `packages/claude-runner/src/ClaudeRunner.ts`
- **Session Management**: `packages/core/src/session/`
- **Edge Worker**: `packages/edge-worker/src/EdgeWorker.ts`
- **OAuth Flow**: `apps/proxy/src/services/OAuthService.mjs`

## Testing MCP Linear Integration

To test the Linear MCP (Model Context Protocol) integration in the claude-runner package:

1. **Setup Environment Variables**:
   ```bash
   cd packages/claude-runner
   # Create .env file with your Linear API token
   echo "LINEAR_API_TOKEN=your_linear_token_here" > .env
   ```

2. **Build the Package**:
   ```bash
   pnpm build
   ```

3. **Run the Test Script**:
   ```bash
   node test-scripts/simple-claude-runner-test.js
   ```

The test script demonstrates:
- Loading Linear API token from environment variables
- Configuring the official Linear HTTP MCP server
- Listing available MCP tools
- Using Linear MCP tools to fetch user info and issues
- Proper error handling and logging

The script will show:
- Whether the MCP server connects successfully
- What Linear tools are available
- Current user information
- Issues in your Linear workspace

This integration is automatically available in all Cyrus sessions - the EdgeWorker automatically configures the official Linear MCP server for each repository using its Linear token.

## Publishing

For publishing and release instructions, use the `/release` skill (within Claude Code or Claude Agent SDK) which provides a complete guide for publishing packages to npm in the correct dependency order. Invoke it with:

```
/release
```


## Gemini CLI for Testing

The project uses Google's Gemini CLI for testing the GeminiRunner implementation. Install the specific version:

```bash
npm install -g @google/gemini-cli@0.17.0
```

This ensures consistency when running integration tests that interact with the Gemini API.

### Gemini Configuration Reference

For detailed information about Gemini CLI configuration options (settings.json structure, model aliases, previewFeatures, etc.), refer to:
- **Official Documentation**: https://github.com/google-gemini/gemini-cli/blob/main/docs/get-started/configuration.md

The GeminiRunner automatically generates a `~/.gemini/settings.json` file with single-turn model aliases and preview features enabled if one doesn't already exist.
