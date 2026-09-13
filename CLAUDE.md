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

3. **Git Worktrees**: When processing issues, the agent creates separate git worktrees. If a `cyrus-setup.sh` script exists in the repository root, it's executed in new worktrees for project-specific initialization. Symmetrically, if a `cyrus-teardown.sh` script exists in the repository root, it's executed in the worktree directory immediately before the worktree is removed when the issue reaches a terminal state (completed / canceled / deleted).

4. **Testing**: Uses Vitest for all packages. Run tests before committing changes.

5. **Sandbox Egress Proxy & CA Certificates**: When sandbox is enabled, the egress proxy generates a CA cert at `~/.cyrus/certs/cyrus-egress-ca.pem` for TLS interception. Per-session env vars are set in `RunnerConfigBuilder.buildSandboxConfig()` to cover most tools:
   - `NODE_EXTRA_CA_CERTS` (Node.js), `GIT_SSL_CAINFO` (Git), `SSL_CERT_FILE` (OpenSSL/Ruby), `REQUESTS_CA_BUNDLE` / `PIP_CERT` (Python), `CURL_CA_BUNDLE` (curl/OpenSSL), `CARGO_HTTP_CAINFO` (Rust), `AWS_CA_BUNDLE` (AWS CLI), `DENO_CERT` (Deno)
   - **`systemWideCert` config flag**: When `sandbox.systemWideCert: true` is set in `config.json`, all per-session CA cert env vars above are skipped — the OS cert store handles trust for all tools. Set this after trusting the CA cert system-wide via `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ~/.cyrus/certs/cyrus-egress-ca.pem` (macOS) or `sudo cp ~/.cyrus/certs/cyrus-egress-ca.pem /usr/local/share/ca-certificates/cyrus-egress-ca.crt && sudo update-ca-certificates` (Linux).
   - **Gotchas — tools that ignore env vars and require system keychain trust**: Bun, .NET/nuget, curl on macOS (compiled against SecureTransport, the default). For these, users must trust the cert system-wide (see above) regardless of the `systemWideCert` setting.
   - **Gotcha — parent process env vars**: If `GIT_SSL_CAINFO`, `SSL_CERT_FILE`, or `CURL_CA_BUNDLE` are set in the Cyrus parent process env (e.g., from a previous test or `.env`), they can break git push/fetch from the Cyrus process itself (not child sessions). The parent process does not route through the egress proxy, so these vars should not be set in `~/.cyrus/.env`.
   - Pre-existing `NODE_EXTRA_CA_CERTS` from the host environment are merged into a combined bundle via `EgressProxy.buildCACertBundle()`.

6. **Two Separate Permission Systems — Tool vs. Sandbox**:
   Claude Code enforces security through two independent mechanisms that must both be configured correctly:

   **A. Tool permissions** (`allowedTools` / `disallowedTools` → `--allowedTools` / `--disallowedTools` CLI flags)
   - Checked by Claude Code's permission layer — NOT enforced at the OS level.
   - `Read(~/**)` does **not work** as a `disallowedTools` pattern — `~` is not expanded to the home directory path by Claude Code, so the pattern never matches. Other `**` glob patterns work fine; the problem is specific to the `~` prefix.
   - `disallowedTools` IS an instant deny that takes precedence over `allowedTools` — if a parent path is denied, all its descendants are blocked. The problem is purely that `~` is never expanded, so `Read(~/**)` silently matches nothing.
   - **Absolute paths in tool patterns require a double leading slash** — Claude Code's parser requires `//absolute/path` (e.g. `Read(//Users/alice/.ssh/**)`) for absolute paths. This is also the key to working with home directory paths: instead of `Read(~/**)` (which doesn't expand), you use `Read(///Users/alice/.ssh/**)` with the resolved absolute path. The double-slash is added in code as `/${fullPath}` where `fullPath` is already absolute.
   - Solution: `buildHomeDirectoryDisallowedTools(cwd, allowedDirectories)` in `packages/claude-runner/src/home-directory-restrictions.ts` enumerates the home directory explicitly using these double-slash absolute paths — bypassing the tilde expansion issue by naming each sibling concretely. `allowedDirectories` paths are excluded so the attachments dir and repo paths remain readable. This is wired into `ClaudeRunner.ts` automatically.

   **B. Sandbox filesystem permissions** (`sandbox.filesystem.allowRead` / `denyRead` / `allowWrite`)
   - Enforced at the **OS level** via bubblewrap (Linux) or macOS sandbox — no shell or Claude Code involvement.
   - A **true deny+whitelist model works here**: `denyRead: ["~/"]` + `allowRead: ["."]` is sufficient to deny the entire home directory while allowing the worktree. `"."` resolves to the cwd of the primary folder Claude is working in.
   - Configured in `buildSandboxConfig()` in `packages/edge-worker/src/RunnerConfigBuilder.ts`.

   **Key invariant**: If sandbox is enabled, both systems should restrict home directory reads. If sandbox is disabled (e.g. in local dev), only tool permissions apply — and those require explicit enumeration via `buildHomeDirectoryDisallowedTools`.

7. **Updating `@anthropic-ai/claude-agent-sdk`**: Whenever you update the `claude-agent-sdk` dependency (which bundles a specific Claude Code version), you **must refresh the tool allowance lists** in `packages/claude-runner/src/config.ts`. Run:
   ```bash
   ./scripts/extract-claude-tools.sh
   ```
   This executes `claude -p "say hi" --output-format stream-json --verbose` and extracts the tool names from the `init` block. Compare the output against the `availableTools` array in `config.ts` and update it to match. Also review `readOnlyTools`, `writeTools`, and the helper functions to ensure new tools are categorized correctly. Failing to do this can cause sessions to silently miss new tools or reference removed ones.

8. **Routing Behavior & Self-Describing Prompts**: When changing repository routing behavior (e.g., description-tag syntax, label routing, base branch overrides, multi-repo support), you **must also update the system prompts that describe these capabilities to Cyrus itself**. The product relies on self-describing prompts so that Cyrus can correctly instruct users and create properly-routed sub-issues. Known locations (not exhaustive):
   - `packages/edge-worker/src/PromptBuilder.ts` — Generates the `<repository_routing_context>` XML block included in session system prompts, documenting routing methods and priority order
   - `packages/edge-worker/src/SlackChatAdapter.ts` — Builds the Slack chat system prompt including orchestration notes with repo routing syntax
   - `packages/edge-worker/src/ZulipChatAdapter.ts` — Same, for the Zulip chat system prompt
   - `packages/edge-worker/src/ActivityPoster.ts` — Posts routing activities to Linear timeline (method display names, formatting)

9. **Adding a new top-level `EdgeWorkerConfig` field**: Adding a property to the `EdgeConfigSchema` Zod schema in `packages/core/src/config-schemas.ts` is **not enough** to make it available at runtime. Two hand-maintained copy sites exist, and both now have guardrails that fail fast when a field is missed (added after `strictMcpConfig` was silently dropped in CYPACK-1478; `slackAllowedTools` & friends were dropped the same way in CYHOST-967):

   - **Cold start** — `WorkerService.startEdgeWorker()` in `apps/cli/src/services/WorkerService.ts` spreads the entire file config (`...edgeConfig`) into the `EdgeWorkerConfig`, so plain pass-through fields flow automatically and need **no** code change. Only add an explicit line below the spread if the field needs env-var precedence or a computed/param override — never add a redundant pass-through line. The `"forwards every EdgeConfig field"` test in `WorkerService.test.ts` has a schema-complete fixture that fails when a new schema field isn't covered.
   - **Hot reload** — `ConfigManager` in `packages/edge-worker/src/ConfigManager.ts` merges a hardcoded list of fields in `loadConfigSafely()` and watches the same list in `detectGlobalConfigChanges()`. Both are driven by the `RELOAD_MERGED_KEYS` const at the top of the file, which has a **compile-time exhaustiveness check**: adding a schema field without classifying it into `RELOAD_MERGED_KEYS` (plus a merge line in `loadConfigSafely()`) or `RELOAD_EXEMPT_KEYS` is a `tsc` error that names the missing key.

   So the workflow for a new field is: add it to `EdgeConfigSchema`, let `tsc` and the CLI test point at the two sites, add the merge line + `RELOAD_MERGED_KEYS` entry (hot reload) and — only if it needs env precedence — an explicit override in `startEdgeWorker()`.

10. **Changing the `cyrus-tools` MCP server's exposed tools**: When you add or remove a tool from the inline `cyrus-tools` MCP server (the one served by `apps/proxy` / wired up in `McpConfigService.buildMcpConfig`), you **must also update the catalog `cyrus-hosted` keeps for the `/settings/tools` UI**. cyrus-hosted maintains a per-server tool list so its grid can render a row per tool (with the right per-platform toggle) without having to introspect a live MCP server. Today that catalog lives in `apps/app/src/lib/cyrus-config/builder.ts` under the `KNOWN_MCP_TOOLS` map (look for the `"mcp__cyrus-tools"` key); update that array in the same PR — the same constants are also imported by the platform-default lists in `packages/core/src/allowed-tools-defaults.ts` when a particular `cyrus-tools` tool is enabled by default, so reflect that there too if the new tool should be on out of the box.

   Symptom of forgetting this: the new tool is callable at runtime (the runtime knows about it via the live MCP server) but it never appears in the `/settings/tools` MCP Servers section — so operators can't see it, can't toggle it on/off per platform, and per-repo overrides treat it as unknown.

11. **Adding a new path-bearing field to `EdgeWorkerConfig`**: cyrus-hosted emits self-host paths with literal `~/` prefixes (e.g. `~/.cyrus/mcp-configs/mcp-supabase.json`) because the user's home directory is not known server-side. Node's `fs.readFileSync` does **not** expand `~`, so any path string that flows from `config.json` to `readFileSync` (or to a child SDK that does the same) must be run through `resolvePath` from `cyrus-core` first.

   Per-repository paths (`repositoryPath`, `workspaceBaseDir`, `mcpConfigPath`, `promptTemplatePath`) are already normalized at three sites in `EdgeWorker.ts`: the constructor, `addNewRepositories`, and `updateModifiedRepositories`. Each builds a `resolvedRepo` via `resolvePath(...)` before inserting into `this.repositories`, so downstream consumers (e.g. `RunnerConfigBuilder`, `McpConfigService.buildMergedMcpConfigPath`) get already-absolute paths.

   **Top-level (non-repo-scoped) path fields are a separate, easy-to-miss codepath.** They live directly on `EdgeWorkerConfig` and are read straight off `this.config.<field>` — they do not go through the repo-resolution loop. When you add one, you must also normalize it. The canonical site for this is `EdgeWorker.normalizeConfigPaths()` (called once in the constructor and once on `configChanged`); add your field there alongside `slackMcpConfigs` / `linearMcpConfigs` / `githubMcpConfigs`.

   Symptom of forgetting this: self-host sessions crash with `ENOENT: no such file or directory, open '~/.cyrus/...'` while cloud sessions (which get absolute paths from cyrus-hosted) work fine. This bit us with the three platform MCP config arrays added in CYHOST-967 / v0.2.53 — they were the only path-bearing fields on `EdgeWorkerConfig` that bypassed normalization, and crashed every self-host session that had a connected platform MCP integration.

12. **ACA executor and Azure router invariants**:
   - ACA sandboxes use server-assigned GUIDs; issue identity is labels-only (`cyrus.issue`, `cyrus.device-id`, `cyrus.disk`). The ARM sandbox-group body is `properties: {}` and has no `maxSandboxCount` or default CPU/memory/disk fields. Per-sandbox create config is the source of truth.
   - ACA `Running` is infrastructure state, not worker-process liveness: an exited entrypoint can leave `tini` and the sandbox Running. Reconciliation must include router device/WSS heartbeat state. This applies to `resumeSandbox` too — `AcaSandboxesProvider` polls the router's `deviceConnectivity` seam after a resume (`resumeConnectTimeoutMs`, default 90s) and replaces a sandbox whose worker never rejoins, rather than reporting success on infrastructure state alone.
   - Suspend delivers no SIGTERM. Keep ACA auto-suspend disabled and let the affinity-aware router idle sweep stop workers. Explicit snapshots preserve env/device tokens, require lineage checks, and are never garbage-collected by Azure.
   - **The idle clock must be reset by the AGENT working, not only by the router
     acting on it.** `created_ms`, `last_routed_ms` and `parked_at_ms` are all
     stamped by something the router does, and the router does nothing at all
     while a session runs — so a sandbox busy for 30 minutes reads as 30 minutes
     idle, is permanently past `idleStopMs`, and survives on the `affinity > 0`
     gate alone. That made the pin load-bearing rather than defensive, and the
     implement→review handoff — where one session's affinity drops before the
     next is established — is exactly where it lapses (NOR-366: 5 of 9 sessions
     killed in one day, 3s–176s after starting). `devices.last_active_ms`
     (`markDeviceActive`) is the fix and is stamped in TWO places for two
     different windows: in `setSessionAffinity`, so a claim resets the clock in
     the same call that creates the pin rather than a sweep later, and in the
     sweep on every pinned tick. It is unconditional — the inverse of
     `markDeviceRunning`'s set-if-null contract, and the reason the two columns
     are separate. Any new idle-like clock needs the same question asked of it:
     what moves this while an agent is silently working?
   - **The affinity gate is re-checked immediately before `executor.stop()`,
     against a SNAPSHOT of session ids, not against a raw count.** Two awaits
     separate the gate from the stop (the reconciler's round trip, then
     `status()`), which is enough to lose the race. But two paths reach the stop
     with affinity rows still in the table *on purpose* — a leaked row the
     reconciler declined to trust, and an offline device's row aged out past
     `offlineAgeOutMs` — so a "block if any affinity exists" re-check silently
     restores the permanent pin PAR-146 removed. Only session ids absent from
     the pre-gate snapshot may veto a stop.
   - **`sweepOnce`'s opening `listContainerDevices()` and `now()` are a WORK
     LIST, not data to decide from.** The loop is sequential and blocks on
     provider control-plane calls, so a tick routinely outlives its own 60s
     interval — one measured 392s. Deciding a row at 07:51:54 from 07:45:22's
     clock and row makes `idleForMs = now - lastRoutedMs` arithmetic on two
     numbers that no longer relate, and the route stamped at 07:51:39 is
     invisible to every check, NOR-366's `claimedMidSweep` guard included: that
     guard compares affinity against a snapshot taken *after* the claim, so it
     correctly sees nothing new (NOR-406 — stopped 4s after the session started,
     issue stuck 37 minutes). Every value a decision uses is re-read inside the
     row's own iteration via `getContainerDevice(deviceId)` + `this.now()`, and
     re-derived once more immediately before `stop()`. Keyed by device id, never
     issue key: a destroyed-and-recreated row is a different container. The one
     thing that stays tick-level is the provider listing — one call per provider
     per tick is its whole cost model — so the claim is scoped to the STOP and
     DESTROY decisions, and the gauge state is up to one tick stale. That
     listing is not read-only input, which is the part the cost argument does
     not cover: `sampleSandbox` writes `running_since_ms` off it, and a
     container booted after the listing was taken would have the clock its boot
     just stamped cleared by a listing that predates it — silently resetting the
     6-hour long-running-sandbox alert for exactly the sandboxes that were busy
     through a slow tick. The listing carries its `capturedMs` and the clear is
     refused when `running_since_ms` is newer; every gauge sample reports its
     own `listing_age_ms` so the staleness is a number rather than an
     assumption.
   - **Every idle-stop the sweep abandons emits `sandbox.idle_stop_skipped`
     with a closed-set `cyrus.reason`** (`row_deleted` | `clock_moved` |
     `claimed_mid_sweep` | `terminal_settle`), and the `sandbox.sweep_completed`
     rollup carries a `deferred` count. Without it the success signal for this
     whole fix is an ABSENCE of `sandbox.idle_stopped`, which is
     indistinguishable from a stalled sweep, and a container held out of
     parking indefinitely buckets as an unremarkable `running` — the same
     three-plain-fields silence that let NOR-366 run for nine hours. Every guard
     is written to be bounded, so a device deferring on essentially every tick
     is a bounded mechanism that stopped being bounded; that is what
     `alert-*-sandbox-idle-stop-deferred` fires on. A new skip path must add a
     `reason` and be emitted through `noteIdleStopSkipped`, never logged in
     prose alone.
   - **The dangerous moment to stop a container is the seconds AFTER a run
     ends.** The worker's `session_state` frame is durably buffered and replayed
     until acked, and its artifact bundle is still uploading — stop it there and
     the frame never lands, so the affinity row and the issue lock survive with
     nothing left alive to release them. `getLastAgentRunActivityMs` (over
     `agent_runs.ended_ms` / `last_agent_activity_ms`) vetoes a stop within
     `terminalSettleMs`. It covers the reconciler's `markAgentRunUnknown` reclaim
     too, which is precisely "the device is done and the router never saw a
     frame". The veto's LOOKBACK is CLAMPED to `idleStopMs` — how old a run
     stamp may be and still veto, not the cumulative deferral, which is bounded
     instead by `lastRunMs` freezing once a run goes terminal. It must cover
     seconds, never become the dominant term in the parking policy, or it is
     PAR-146's permanent pin under another name; a deferral that does not end is
     what `alert-*-sandbox-idle-stop-deferred` exists to catch. Know its real
     reach before relying on it:
     `last_active_ms` is stamped by the SWEEP, so it is itself up to one tick
     stale, and with the clamp a veto needs the newest run stamp to beat the
     whole idle clock by `idleStopMs - terminalSettleMs` (180s at defaults). On a
     healthy 60s tick it CANNOT fire and the fresh per-row read is doing all the
     work; it goes live exactly in the 392s-tick regime, which is the residue the
     fresh read cannot cover.
   - **`state=stopped && sessions>0 && online=false` is an impossible state that
     produces no signal on its own.** No lifecycle transition fires, the gauge
     records it as three unremarkable fields, and Linear keeps rendering a live
     agent session — which is why NOR-366 ran for nine hours. `noteStranded`
     emits `sandbox.stranded_session` with `reason=offline_pinned` for it, and it
     is DETECTION ONLY: waking the container would also resurrect leaked-affinity
     rows and undo idle-stop for the sandboxes idle-stop exists for. It must stay
     excluded during the cold-boot window (`strandedSessionGraceMs`, sized against
     an ACA boot, which presents identically) and for issues with a pending
     terminal teardown.
   - **The OTHER stranded shape looks completely healthy, and "looks healthy"
     cannot be the exclusion.** `running && online && sessions>0` with nothing
     routed and nothing posted is what a session that never reached a terminal
     state produces: it holds the issue lock forever, and a new top-level comment
     on that issue is then rejected at the lock, so the issue is write-only.
     CAN-133 sat in it for 5h17m while the severity-1 rule named after this
     failure could not fire, because the old detector required
     `stopped && !online` (NOR-402). `noteStranded` now also emits
     `reason=no_progress`, and the clock it uses is the whole point:
     `max(last_progress_ms, last_routed_ms, parked_at_ms, created_ms)`.
     `last_seen_ms` is excluded (a wedged worker heartbeats normally) and
     `last_active_ms` is excluded (the sweep stamps it on every pinned tick, so
     the detector would reset its own clock). **`devices.last_progress_ms` is
     stamped ONLY from a device-originated `rpc_request`** in `DeviceGateway` — a
     sandbox holds no Linear token, so every activity its agent posts arrives as
     one, which makes it the only clock moved by the agent working rather than by
     something the router did. Do not feed it into the idle clock: idle-stop must
     keep erring toward keeping a container alive (NOR-366).
   - **`no_progress` cannot tell a strand from a session deliberately waiting,
     and the honest move is to say so, not to tune the threshold until it looks
     like it can.** A session held open by pending work keeps its affinity and
     posts nothing, so it is byte-for-byte the same shape — the deferral is
     decided on the DEVICE and never reaches the router's store. So the report
     names both possibilities, sends the operator to the
     `session.terminal_deferred` / `session.terminal_signalled` pair to
     disambiguate, and gates `cyrus router unlock` on having confirmed it is not
     waiting: unlocking a run that is about to resume manufactures the
     lock-without-affinity leak instead of fixing anything.
     `sessionNoProgressMs` is 4h to clear `ScheduleWakeup`'s 1h clamp outright;
     a longer-period cron is a known false-positive class. Anything that lowers
     it must first give the router a way to see the deferral. It is settable as
     `containers.sessionNoProgressMs`, and that is not a nicety: this is a
     severity-1 rule that knowingly fires for a legitimate long cron, so without
     a knob the only remedy is muting it — which also mutes `offline_pinned` and
     is the exact alert-fatigue failure the detector exists to end. Any new
     threshold on this rule needs the same reachability from `router-config.json`.
   - **The `deferred`/`signalled` pair must be compared by TIME, never by
     membership, and the query that does it is load-bearing.** A Linear agent
     session id spans turns: `AgentSessionManager.addAgentRunner` clears
     `terminalEmittedSessions` on every runner re-attach, so each cleanly
     finished turn emits its own `session.terminal_signalled` under the SAME id.
     An anti-join on "has this id ever signalled" therefore deletes exactly the
     sessions that completed once and then deferred forever — and since replying
     in-thread is the documented recovery for a lock rejection, the workaround
     for NOR-402 MANUFACTURES that shape. Worse than a blind spot: the alert
     tells the operator to run this query before `cyrus router unlock`, so an
     empty result reads as "not waiting" and licenses the unlock. Compare
     `last_deferred > last_signalled`, use `arg_max` so the pending-work columns
     describe the current stall, and remember a row does NOT prove the lock is
     still held (reconcile, teardown, unlock and TTL expiry all release without a
     signal) while zero rows does NOT prove health. Note also that
     `session.held_open` / `session.pending_work_recorded` carry
     `cyrus.agent_session_id` too, but theirs is the CLAUDE SDK session id — the
     two families do not join, and KQL returns nothing rather than erroring.
   - **`check-bicep.sh` compiles the template; it does not evaluate the KQL
     inside it.** ARM stores a saved search as an opaque string and never
     validates it, so neither a parse error nor a wrong-but-valid query is
     caught by a green `infra` check — and the first time anyone opens a saved
     search is mid-incident. A new or edited saved search has to be RUN against
     the workspace (`az monitor log-analytics query --workspace <customerId>
     --analytics-query "$(cat q.kql)"`) before it is relied on. Running it is
     also the only way to catch the semantic half: `Cyrus-Sessions-Never-Terminal`
     shipped a `leftanti` that was perfectly valid KQL and still answered the
     wrong question, which no amount of compiling would have shown.
   - **Neither stranded shape covers a locked issue with NO affinity.** Both are
     reached only from the sweep's `affinity > 0` gate, but a `parked` session
     releases affinity and RETAINS its lock — so an elicitation nobody answers
     locks an issue invisibly to `noteStranded`, surfacing only in
     `RouterStore.listSessions`' orphan-lock query behind
     `cyrus router sessions list`. Do not read the detector as covering every
     unreachable issue.
   - **`reclaimStranded` MUST run below the `affinity > 0` gate, and scoping it
     above that gate makes it unreachable while its tests still pass.**
     `resolveAffinity` returns non-zero in exactly two situations and each is
     individually incompatible with a multi-hour quiet threshold: an ONLINE
     device, whose `last_seen_ms` `DeviceGateway`'s pong handler restamps every
     30s (so the clock is never over ~90s old), and an OFFLINE device whose
     newest claim is inside `offlineAgeOutMs`, which the clock folds in. The
     first cut of CYR-84 shipped it inside the pinned branch and it could never
     have fired; the tests passed on an `isOnline: true` fixture with a
     day-stale heartbeat, a state the gateway makes impossible. Any test for this
     path needs `isOnline: () => false` or a real `touchDevice` stamp.
     What it actually bounds is the OTHER side of that gate: a leaked affinity
     row ages out after `offlineAgeOutMs` and the container then sits on
     `staleDestroyMs`'s three-column, 14-DAY clock (`last_routed_ms`,
     `last_seen_ms`, `created_ms`) — CYR-84's audit found sandboxes alive for
     work finished days earlier. The reclaim is the same destroy on 72h, bought
     with `quietSince`: those three plus `last_progress_ms`, `parked_at_ms`, the
     newest agent-run stamp and the newest session claim. Three things about that
     clock are load-bearing. It EXCLUDES `last_active_ms` — the sweep stamps that
     every pinned tick, so the loop would reset the clock it reads, the same trap
     `no_progress` documents. It INCLUDES `last_seen_ms`, which `no_progress`
     excludes, and that is what keeps the `no_progress` shape (live worker
     holding an issue it stopped working on) detection-only: a heartbeating
     worker is a live process holding a workspace, and "is it making progress" is
     a question for a human, not for a destroy. And it is SPLIT —
     `quietSinceOnRow` (row columns only) before `resolveAffinity`'s round trip
     to the device, the full version immediately before the destroy — because
     adjacent checks are theatre: only a gate and a veto on opposite sides of an
     await can let a session claimed during that await veto anything.
     `reclaimStrandedMs` must sit strictly between `sessionNoProgressMs` and
     `staleDestroyMs`, and the constructor warns at BOTH ends: below the first the
     destroy beats the report a human would act on, at or above the second
     stale-destroy reaches the row first and the reclaim is inert. `0` disables.
   - **The disk-image GC had never run in the deployment that needed it, and the
     reason was the gate, not the algorithm.** It hung off
     `DevcontainerImageService`, constructed only when `containers.devcontainers`
     is set — a field `RouterConfigFileSchema` does not model at all, so Zod
     strips it and no `router-config.json` can enable it. Meanwhile the images
     that accumulate are the DEPLOYMENT worker images
     `scripts/deploy-worker-image.sh` registers out of band, one per build, which
     have no `repo_devcontainer_images` row and so were not candidates under the
     old cache-table iteration either (14 images / 68 GB, 8 collectable).
     `DiskImageCollector` reconciles the PROVIDER's inventory and
     `RouterServer.scheduleDiskImageGc` gates on `containers.aca`; when the
     devcontainer service exists its collector is REUSED, never a second one.
     Three invariants inside it. TWO FLOORS, and neither subsumes the other: a
     staged build and a rollback candidate are both referenced by nothing, so a
     pure reference count deletes the deploy about to go out and the one you
     would fall back to (`imageRetentionMs`, 7d) — but an age window alone makes
     rollback DEPTH a function of deploy cadence, so a deployment shipping less
     often than the window is long silently keeps nothing
     (`imageRetentionCount`, 3, counted over unreferenced images only). Second,
     `aca_disk_image_sightings` exists because the ACA data plane does not date a
     disk image — the spike recorded `{id, name, labels, image, status,
     sizeInMB}` and no timestamp — so a policy reading only the wire is silently
     either a no-op or unbounded depending on what the preview API returns. Age
     is `min(provider timestamp, first sight)`; a disk absent from a listing has
     its sighting DROPPED so a re-registered name is dated anew rather than
     inheriting a first-sight that would make a brand-new image instantly
     collectable. Third — and this is the one first-sight cannot cover — that
     `min` means an unsanitised provider timestamp can only ever make an image
     look OLDER, so it is BOUNDED to a plausible range: the field is undeclared
     and unobserved, and .NET's `DateTime.MinValue` sentinel parses cleanly and
     would empty the group in one cycle. Keeps are recorded as fully as deletes
     (`sandbox.image_decision` carries the protection that applied): a
     wrongly-deleted rollback image is invisible in a rollup and surfaces only as
     a boot that cannot find its disk. One router per sandbox group — every
     store-side protection is read from that router's own DB — which was already
     true before disk images, since the orphan GC destroys any sandbox with no
     device row of its own.
   - **A session's terminal signal can be withheld indefinitely, and that is the
     leading suspect whenever an issue goes unreachable.**
     `AgentSessionManager.completeSession` defers `emitTerminalOnce` while the
     runner reports pending work (crons, background tasks, live background
     tasks), and retries only when a later `result` arrives — so a background
     task that never exits holds the router's issue lock forever. It is now
     `session.terminal_deferred` / `session.terminal_signalled` rather than an
     `info` line, and that change is load-bearing: **a sandbox worker's
     `RouterLogForwarder` is WARN+ by default**, so the `info` never left the
     container and the one state that can strand an issue was absent from the
     logs it had to be diagnosed from. Any new diagnostic on a worker code path
     must be `logger.event`, which bypasses the threshold, not `logger.info`.
   - `ContainerLifecycle.sweep()` is **non-reentrant by contract** — a tick still
     running makes the next one a logged no-op. `RouterServer` fires it on a bare
     60s `setInterval` and the loop is sequential, so without that guard a single
     slow `executor.stop()` makes ticks overlap, and each overlapping tick queues
     another `stop()` on `AcaSandboxesProvider`'s unbounded per-issue FIFO lock.
     The queue then grows faster than it drains and `TerminalTeardown`'s
     `destroy()` — same lock — is starved indefinitely. Never "fix" a slow sweep
     by letting ticks run concurrently.
   - Snapshot/suspend/resume move the sandbox's whole memory + disk image and are
     **not** control-plane calls: measured 3m52s (snapshot) and 4m09s (stop) on an
     18.4 GB sandbox. They use `SLOW_OPERATION_TIMEOUT_MS`, not the 120s
     `DEFAULT_REQUEST_TIMEOUT_MS`; a call that aborts client-side still completes
     server-side, so a too-tight deadline yields permanent retry loops rather than
     a clean failure. Relatedly, `stop()` treats the snapshot as **best-effort** —
     it is a cold-path optimisation (a Suspended sandbox resumes from its own
     frozen memory; a snapshot is only consulted when the sandbox is ABSENT), so
     it must never be able to veto the suspend and leave a sandbox billing.
   - A memory suspend also **freezes every JavaScript timer** in the sandbox, so any device-side liveness check must compare **wall-clock** time (`Date.now()`), never accumulated timer ticks — a tick-counting check sees no gap after resume. `RouterConnection`'s watchdog terminates its socket after `MAX_MISSED_HEARTBEATS` × the router's advertised `heartbeatMs` of inbound silence (both constants live in `cyrus-router-protocol`; the router advertises its real cadence in `hello_ack`). Derive new liveness deadlines from those constants rather than hardcoding a number.
   - Azure router hosting must remain one replica. SQLite stays on ephemeral local storage and is periodically backed up to Blob; Azure Files is for artifact bundles, not SQLite WAL. Blob restores are at-least-once within the backup interval, and overlapping revision uploads can be out of order.
   - **A stale restore can roll `devices.next_seq` backwards while the device's
     `lastAckedSeq` survives in its floor bundle.** Once `next_seq <=
     lastAckedSeq`, `RouterConnection.onEvent` discards every event we issue as
     a duplicate — permanently, and with no signal on either side (NOR-263).
     `hello` is the ONLY point where the two numbers are ever in the same
     process, so `DeviceGateway.handleHello` calls
     `RouterStore.reconcileDeviceSeq` there to fast-forward past the device's
     mark and log at ERROR. Two rules for anything touching that path: the
     reconcile must stay **ahead of the already-acked purge** — the purge
     deletes exactly the rows the regression stranded — and under detected skew
     queued events are **resequenced above the mark, not treated as
     duplicates**, because re-delivering a genuine replay is recoverable while
     dropping a user's prompt is the bug. Neither the ERROR log nor the repair
     removes the root cause; the 5-minute snapshot on ephemeral disk still
     produces the skew, and this only bounds the damage.
   - `containers.keyVaultUrl` selects the Key Vault secret backend. Rotated per-user values reach only create-from-image; destroy and re-prompt existing issues to apply them. Entra enrollment uses one app registration/audience per router deployment.
   - Terminal teardown order is force floor flush, WIP/teardown/worktree removal, authenticated callback, provider destroy (including snapshots), then device-row deletion; only deleted issues lose their floor bundle. Self-actored closes and Linear's `duplicate` state miss `issueStatusChanged` and rely on stale GC/manual cleanup.
   - The teardown callback is durable on both sides. Device: `TeardownCallbackQueue` records the intent (plus its idempotency key) to `~/.cyrus/router-client/teardown-callbacks.jsonl` **synchronously, before the first `await` of `handleIssueStateChangeMessage`** — that is what puts the write inside the window where `RouterConnection`'s inbox entry is still unprocessed, so a kill anywhere in the sequence replays instead of losing the callback. It replays on the connection's `"connected"` event and retries the same key with backoff. Router: `TerminalTeardown` mirrors each pending teardown into the `container_teardowns` table so the out-of-process `router containers list` can render its `TEARDOWN` column; that mirror is observability + retry accounting, NOT a restart journal, and is cleared on construction to match the coordinator's empty in-memory state. Re-delivered callbacks log as `callback retry`, distinct from `grace expiry`.
   - `ContainerTargets.inFlightBoots` joins a concurrent boot **only as a dedup of overlapping `ensureRunning`/`mintDeviceToken` work — never as evidence the container ended up running**. The joined attempt may predate the event the joiner is reacting to (classically: the idle sweep parked the container while it was still starting), so after joining, re-check `executor.status()` and boot for real if it is not running. Getting this wrong silently swallows a terminal-teardown wake, and only the grace deadline then reclaims the container. An attempt in flight past `BOOT_JOIN_TIMEOUT_MS` is abandoned rather than joined, so a hung provider call cannot permanently disable booting for a device. Every `AcaSandboxClient` request also carries a `requestTimeoutMs` deadline (default 120s) because Node's `fetch` has none, and an unbounded call blocks the provider mutex and the boot slot behind it.
   - Before Azure stack deletion, destroy managed sandboxes and sweep snapshots before destroying the sandbox group. Keep the operator Blob role for corrupt-backup break glass. See `infra/azure/README.md` and `docs/ROUTER.md`.
   - **The Azure deployment is Bicep (`infra/azure/bicep`), applied with
     `scripts/deploy-azure.sh`. There is no Terraform and no state file.** Three
     consequences bind anything you change there:
     1. **Incremental only.** ARM never deletes a resource that leaves the
        template, which is what lets the per-user secret store's Table and KEK
        outlive `enableSetupSecretStore` instead of needing `prevent_destroy`.
        `--mode Complete` would delete the KEK that unwraps every stored
        per-user secret; `deploy-azure.sh` does not offer it and nothing should.
     2. **Two guarantees live in the deploy script, not the template**, because
        ARM cannot express them: the character-level half of the immutable
        image-tag policy (no regex engine), and the `/setup` stage-1-before-
        stage-2 ordering gate (no plan phase, so no equivalent of Terraform's
        "read the deployed authConfigs child" data source — the script asks
        `az containerapp auth show` instead). Both are bypassed by calling
        `az deployment` directly. Anything that changes those rules must change
        `scripts/deploy-azure.sh`, not only the template.
     3. **Cross-parameter invariants use the `parameterGuard` idiom** in
        `main.bicep` — a violation text used as an object key ARM cannot
        resolve — and the guard is folded into `defaultTags` so it is
        guaranteed to be evaluated. Do not "simplify" it out of the tags, and do
        not replace it with `assert`: assertions require an experimental feature
        flag and emit `languageVersion: 2.1-experimental`.
        **`what-if` does not evaluate the guard; `validate` does.** A
        violating parameter file previews perfectly clean and then fails at
        apply, so every rule here was invisible to the gate routine CD runs.
        That is why `scripts/deploy-azure.sh` runs `az deployment sub validate`
        on the preview path AND the apply path — a new invariant is a gate only
        because that call is there. Test a new rule with `validate`; a green
        `what-if` proves nothing about it.
     Run `./scripts/check-bicep.sh` after any template change; it compiles every
     template, type-checks `main.bicepparam.example` against `main.bicep`, and
     treats warnings as failures.
   - **`aca sandboxgroup disk create` can no longer register the worker image,
     and `workerImage` + `acaDiskName` must move as a pair.** The
     `PUT …/diskimages` import is synchronous and scales with image size, while
     the preview CLI abandons each attempt at ~60s (two attempts, ~120s total)
     and reports it as `Error: Network issue — retry policy expired` — which
     reads as a network blip. Everything past ~1 GB is over the ceiling and the
     image is well past it (NOR-296 reviewed the growth and accepted it), so
     this does not resolve itself. `scripts/deploy-worker-image.sh` issues the
     PUT directly: audience `https://dynamicsessions.io` (NOT
     `management.azure.com`, which 401s), body
     `{labels:{name}, image:{base}, registryCredentials:{username, token}}` —
     the CLI's own shape, with `registryCredentials` a **sibling** of `image`
     and the name in `labels.name` — credential field `token` (NOT `password`,
     which 400s naming the required property), and ONE attempt —
     aborting the client does not abort the server-side import, so a retry
     races a running import rather than replacing it. Nesting
     `registryCredentials` inside `image` is the failure that looks like
     something else: the field is never read, an anonymous pull is attempted
     against a private ACR, and the `401 RegistryAuthFailed` asks for the very
     field that was sent — so every credential *value* is tried in turn and all
     fail identically within seconds, because none of them is read (NOR-337).
     Gate on `disk list` showing `Ready`; a 2xx only says the request was
     accepted. And because
     `workerImage` (what the router advertises) and `acaDiskName` (what the
     group boots) describe one build, a rewrite that lands one without the
     other is undetectable downstream — they are rewritten in a single verified
     pass, and each disk is named after its build so a name that did not move
     means an image that did not either. Retrying instead of doing this is what
     left `sha-d7fb6a3` built-but-never-deployed for four days (NOR-295).
   - Repository selection for **container** targets happens on the **router**,
     in `EventRouter.routeCreated`, before any device row or sandbox exists.
     The decision is persisted in `issue_repositories` and is what
     `ContainerTargets.buildEnv` turns into `CYRUS_REPOS_JSON`, so a sandbox
     clones only the repositories the issue needs and a destroyed-and-recreated
     container clones the same ones. An ambiguous or unmatched issue with no
     default gets a Linear elicitation posted by the router and its `created`
     webhook is HELD in `pending_repo_selections` until the answer arrives —
     nothing boots while the user decides. Physical-device targets still route
     inside their own EdgeWorker.
   - `containers.repositories` in `router-config.json` only **seeds** the
     repository registry, and only when the registry is empty. After that the
     stored registry (Azure Table, or `repositories.json` beside the router db)
     is authoritative and the config array is inert — the router logs this on
     every start. Editing the `.repositories` field of
     `CYRUS_ROUTER_CONTAINERS_JSON` on a seeded deployment changes nothing;
     every other field on that env var (`image`, `routerUrlForContainers`,
     `keyVaultUrl`, `aca`, `tableStore`, …) still takes effect on restart.
   - Azure Table partition keys are namespaced by their first character: `u` +
     sha256(email) for a user's secret record (`setupPartitionKey`), `g` + 64
     zeros for the global repository registry. The registry row is **plaintext
     JSON**, deliberately not envelope-encrypted, so it works without the *Key
     Vault Crypto User* role. Never store a credential on that row.

13. **Logging sinks and OpenTelemetry export**:
   - `ILogger` is the chokepoint for ~957 log calls, but adopting it does **not**
     by itself produce queryable fields — the console sink renders
     `prefix + message`, i.e. prose. The structured payload exists only on the
     forwarding path, so the extension point is the `LogSink` seam
     (`packages/core/src/logging/LogSink.ts`), not the logger interface.
   - `setGlobalLogSink` is **single-slot and clobbers**. `EdgeWorker` installs
     `RouterLogForwarder` when it connects to a router, and the router process
     installs `OtelLogSink`; these never collide today only because they are
     different processes. If you need two destinations in one process, add a
     composite — do not have two components race to install.
   - **Any new sink must guard re-entrancy.** A sink is called FROM the logger,
     and everything under it (`ws`, an OTLP exporter, `@azure/core-rest-pipeline`)
     can log. One unguarded log line on the write path turns a single record into
     an unbounded loop. Both existing sinks use an `inWrite` flag and never log
     anything themselves. Cap message/args/attribute sizes too: these
     destinations are billed per GB.
   - **OTel logs need no ESM loader hook.** `register()` / `--import` are for
     *auto-instrumentation*, which monkey-patches modules and so must run before
     they are imported. `cyrus-otel-logs` calls the Logs API directly from a sink
     the app installs, so it has no import-order constraint and can start
     anywhere in the bootstrap. It also deliberately does not register a global
     OTel logger provider — that would capture any dependency that grabs a logger
     off the global API, making the volume we pay for depend on our dep tree.
   - **`cyrus-otel-logs` must stay vendor-neutral, and `packages/core` must stay
     Azure-free.** The exporter is a constructor argument, and
     `cloud.provider` / `cloud.platform` are inputs to
     `buildResourceAttributes`, never defaults. Everything Azure lives in
     `packages/router/src/telemetry/otelLogging.ts` — the only file importing
     `@azure/monitor-opentelemetry-exporter`. Do not add OTel to
     `packages/core`: it is depended on by every runner and the CLI, so the cost
     lands on upstream installs that never export anything.
   - **OTLP records land in `AppTraces`, NOT `ContainerAppConsoleLogs_CL`.**
     Every saved search and alert rule in `infra/azure/bicep/modules/monitoring.bicep`
     reads the console table and is blind to OTLP records. `service.name` becomes
     `AppRoleName`, `service.instance.id` becomes `AppRoleInstance`, everything
     else is a key in `Properties`. The Application Insights component must be
     **workspace-based**; classic mode keeps its own store, out of reach of those
     queries.
   - **The naming split is deliberate and has exactly three halves.** (a) The
     per-record STRUCTURAL keys — `component`, `sessionId`, `issueIdentifier`,
     `repository`, `platform`, `event`, `args` — keep their Phase 0 names on both
     the JSON console line and the OTLP record. They ride every record, prose
     included, so renaming them is the exhaustive rewrite Phase 4 excludes and
     would break every saved query for no new queryability. (b) `exception.*` is
     stable OTel semconv, describes nothing Cyrus-specific, and is what makes a
     backend render a record as an exception — use the standard names. (c)
     Everything else Cyrus-specific goes under `cyrus.*` via `cyrusAttributes`
     (`packages/core/src/logging/events.ts`), matching the labels already on ACA
     sandboxes. Event names are dotted lowercase (`session.completed`,
     `sandbox.gauge`) — never snake_case — and the domain prefix is load-bearing:
     `event startswith "sandbox."` is how every sandbox alert is scoped.
   - **Namespacing happens at the CALL SITE, not inside a sink.** `cyrusAttributes`
     is applied where the event is emitted. A sink that silently rewrote keys
     would need a list of reserved ones (`event`, `args`, `traceparent`, …) that
     must NOT be rewritten, and that list rots the first time someone adds a
     structural field. A key already containing a `.` is treated as
     pre-namespaced and passed through — which is what lets `exception.*` and a
     future `gen_ai.*` work unchanged, and why a private prefix like `cqo.` must
     be spelled `cyrus.cqo.` at source rather than relying on the helper.
   - **A dotted attribute key is not reachable with KQL dot syntax.**
     `p.cyrus.issue_key` parses as a nested lookup and silently returns null — it
     does not error. Every query over a `cyrus.*` attribute must use bracket
     syntax: `p["cyrus.issue_key"]`. Renaming an event or attribute therefore
     means editing `infra/azure/bicep/modules/monitoring.bicep` in the same
     change; its saved searches and alert rules key on those literal strings.
   - **GenAI semconv (`gen_ai.*`) is evaluated and deliberately NOT adopted** —
     still pre-stable, moved to `open-telemetry/semantic-conventions-genai` with
     no tagged release or schema URL to pin against. See
     `docs/adr/0003-defer-genai-semantic-conventions.md` before reopening it.
   - **`packages/core` has all the console calls it is going to have.** The ~56
     `console.*` matches in it are JSDoc examples; the only real ones are in
     `Logger.ts`, which IS the console sink. The `console.*` left in `apps/cli` is
     interactive UI (OAuth walkthroughs, status tables, prompts) — routing it
     through `ILogger` would stamp timestamps and level labels onto text a human
     is reading, which is a regression, not a cleanup.
   - **Assert on log records, not console output.** Use `RecordingLogSink` /
     `installRecordingLogSink` from `cyrus-core`. Regexing a rendered line
     couples the test to a timestamp format, a level-label width, and
     `CYRUS_LOG_FORMAT` — none of which are what the test is about. `restore()`
     puts back the *previous* sink, not the no-op, so a nested recorder cannot
     disarm an outer one.

14. **Distributed tracing (`cyrus-otel-traces`)**:
   - **Traces register globally; logs deliberately do not.** `startOtelTracing`
     calls `trace.setGlobalTracerProvider`, `propagation.setGlobalPropagator`,
     and `context.setGlobalContextManager` — it has to, because
     `trace.getTracer()` at a call site returns a NO-OP tracer otherwise, so
     every span in the codebase would silently record nothing. The symmetric
     risk that made `startOtelLogging` avoid `setGlobalLoggerProvider` (capturing
     a dependency's volume) does not arise: a library only emits spans if an
     auto-instrumentation patched it, and we install none. Consequence: `withSpan`
     / `withSpanActive` / `withTraceContext` propagate NOTHING until that context
     manager is installed, which is exactly why an untraced process pays nothing
     for the call sites.
   - **The sampler must stay `ParentBased`.** A sandbox worker takes NO sampling
     decision for real work — it inherits the router's off the incoming
     `traceparent`. Anything that lets the two sides decide independently produces
     a *half-collected* trace, which renders as a complete story with a hole in
     the middle and is worse than no trace. `CYRUS_OTEL_TRACES_ENABLED` and
     `CYRUS_OTEL_TRACES_SAMPLE_RATIO` are therefore in `RESERVED_ENV_KEYS` and
     propagated router → sandbox by `ContainerTargets.buildEnv`. See
     `docs/adr/0004-parent-based-head-sampling-for-traces.md`.
   - **Trace context is captured at ENQUEUE time and persisted on the `events`
     row**, not derived when `deliverPending` sends. Delivery routinely happens
     minutes later (an offline device, a cold sandbox boot) from a socket callback
     with no relation to the enqueue's call stack — and that gap is the thing the
     trace exists to show. `reconcileDeviceSeq` carries the columns across a
     resequence for the same reason: a resequenced event is the same event.
   - **A relayed sandbox span is handed straight to the exporter, never re-minted
     through a tracer.** A tracer assigns its own span id, which orphans every
     child the worker already recorded against the original — the trace comes back
     as disconnected fragments. `SandboxSpanRelay` reconstructs a `ReadableSpan`
     and calls `exporter.export`. It also preserves the worker's `resource` (so a
     relayed span still says `service.name = cyrus-worker`) while stamping
     attribution from the authenticated device row OVER the span's own attributes.
   - **Span names must stay low-cardinality.** A span name is the grouping key for
     every latency percentile and error rate in the backend; interpolating an issue
     key or session id gives every request a sample size of one. Identity goes in
     `cyrus.*` attributes. `AcaSandboxClient` templates its request paths for this
     reason (`sandboxes/{name}/stop`), and the Fastify plugin names spans from
     `request.routeOptions.url`, never the concrete path.
   - **Spans land in `AppRequests` (SERVER/CONSUMER) and `AppDependencies`
     (CLIENT/PRODUCER/INTERNAL)** — a third pair of tables, distinct from both
     `ContainerAppConsoleLogs_CL` and the `AppTraces` that Phase 3's log records go
     to. `OperationId` is the W3C trace id and the join key across all of them.
     The bracket-syntax rule for dotted attribute keys applies unchanged:
     `Properties["cyrus.issue_key"]`.
   - **New device→router frame types are capability-gated, never version-bumped.**
     `SPAN_INGEST_CAPABILITY` follows `LOG_INGEST_CAPABILITY` exactly: the router
     advertises in `hello_ack` and the device sends nothing until it sees that,
     because `DeviceGateway.handleMessage` closes the socket on any frame it cannot
     parse. Bumping `PROTOCOL_VERSION` instead would reject every not-yet-updated
     worker outright.
   - **`RouterSpanForwarder` must report `SUCCESS` even when it drops.** A `FAILED`
     export result makes `BatchSpanProcessor` retry — including a batch dropped
     deliberately for cost, which is the loop the volume guard exists to prevent.
     Loss is reported honestly via `dropped` on the next frame that lands. It also
     needs the same `inWrite`-style re-entrancy guard as every sink: it touches
     `RouterConnection`, whose logger feeds `RouterLogForwarder`, which touches the
     same socket.
   - **Do NOT switch on Fastify's built-in pino logger.** `RouterServer` constructs
     Fastify with no options, and `registerHttpTracing` supplies request logging
     through `ILogger` instead. pino writes straight to stdout on its own path,
     bypassing the `LogSink` seam and therefore the OTLP export the whole telemetry
     program is built on. The plugin also strips query strings — several router
     routes carry tokens in query position, and a secret that reaches a telemetry
     backend is disclosed.

15. **Subprocess env scrubbing (`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`)**:
   - **The SDK flag is not the switch; `CYRUS_SUBPROCESS_ENV_SCRUB` is.** Setting
     the SDK flag on a host without bubblewrap does nothing at all, which is why
     it must never be passed straight through from config or inherited from the
     parent env. `resolveSubprocessEnvScrub`
     (`packages/claude-runner/src/sandbox-requirements.ts`) is the only place
     that decides, and both call sites — `ClaudeRunner.start()` and
     `EdgeWorker.warmupRecentSessions()` — set **or unset** the SDK flag
     explicitly. `buildBaseSessionEnv` spreads the entire parent `process.env`,
     so an unset key there means "inherit whatever the worker happened to have",
     not "off". The runner-side assignment is **inert when `config.warmSession`
     is set** — that branch discards `queryOptions` and calls
     `warmSession.query()`, so the warmup's env is what governs. The two agree
     only because both resolve against the same `process.env` in the same
     process; nothing reconciles them, so anything that makes this decision
     per-repository or hot-reloadable must reconcile them explicitly.
     Because every call site overwrites it, a hand-set
     `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` is discarded — including one from a
     repository `.env` or a secret bundle. Discarding it silently is
     indistinguishable from the control working, so the resolver warns once when
     it sees one.
   - **Requested-but-unavailable is FATAL, not a warn — and the throw has to be
     sited OUTSIDE `startWithPrompt`'s `try`.** A security control that degrades
     to off with a `warn` is off again the next time a dependency goes missing,
     and nothing alerts on it — which is how the worker image ran for months
     without `socat` or `bubblewrap` and nobody noticed (NOR-412). But that
     `catch` **does not rethrow**: it emits `"error"` and returns `sessionInfo`,
     and `EventEmitter` only rethrows an *unhandled* `"error"`. Every production
     caller registers an `onError` listener (`EdgeWorker` does), so a throw
     raised inside the `try` resolves `start()` normally and leaves a Linear
     agent session hanging with no activities and no terminal state — the
     NOR-402 shape, and the exact outcome this control exists to prevent. The
     same trap swallows any future precondition check; put it above the `try`,
     where nothing has been allocated for the `finally` to clean up. Test it
     with an `onError` listener registered, or the assertion passes for the
     wrong reason.
   - **Rejecting `start()` is necessary and NOT sufficient — nothing above it
     was listening.** The second half of the same trap: `initializeAgentRunner`
     rethrows, `handleAgentSessionCreatedWebhook` does not catch, and
     `handleWebhook`'s catch logs and *deliberately* does not rethrow so a bad
     webhook cannot take the process down. So the rejection died as one log
     line while `postInstantAcknowledgment` had already posted a thought — the
     session read as working forever, and the router's issue lock and affinity
     stayed pinned, because only `"sessionTerminal"` releases them. The router's
     stranded-session detector cannot see this either: it keys on
     `state=stopped && sessions>0 && online=false`, and here the sandbox is
     running, online, and holds affinity. `AgentSessionManager.failSession()`
     is the fix and both start sites call it before rethrowing. Treat "throws"
     as an unfinished sentence: a start-time failure is only fatal if some
     handler converts it into a terminal Linear state.
   - **The scrub is Linux-only, and "we found nothing to object to" is not "the
     control is in place".** `checkLinuxSandboxRequirements` reports every
     non-Linux host as `supported: true`, which is right for a bubblewrap
     precheck and wrong as the sole predicate for a credential control — it
     returned enabled on macOS having probed nothing at all, on the one platform
     where the undocumented flag is most likely to be a no-op and could never
     fail loudly. `checkSubprocessEnvScrubRequirements` gates on platform for
     that reason. Widen it only for a platform where the scrub has actually been
     observed.
   - **Never cache a negative probe result.** The error we raise tells the
     operator to install the missing packages; memoising the failure means the
     next session after they do fails identically, and every session after that,
     until the worker restarts — on a long-lived ACA sandbox, a
     `router containers destroy` and re-prompt to apply a fix we ourselves asked
     for. `checkLinuxSandboxRequirements` caches only `supported: true`. A test
     asserting "keeps throwing on every session" will pass on the stale cache
     alone, so give it fresh probes or it pins nothing.
   - When the opt-in is absent, the host is **not probed at all** — the
     requirements of a control nothing would have enabled are not interesting,
     and probing for them is what produced the misleading
     "requirements are not met — skipping" warning in every sandbox.
   - **Three prerequisites, and only two of them live in the image — in TWO
     image paths.** `socat` and `bubblewrap` are installed by
     `docker/worker/Dockerfile` (the default image) **and** by
     `features/src/cyrus-worker/install.sh` (per-repository devcontainer images,
     ADR 0006, which never run that Dockerfile). Adding them to one path only
     leaves half the fleet unequipped, and because the opt-in rides the per-user
     secret bundle into every container rather than being per-image, enabling it
     then hard-fails every session on the other half. The Feature version in
     `devcontainer-feature.json` participates in the devcontainer image cache
     key, so a package change there is invisible until the version is bumped and
     `workerFeatureRef` + `workerFeatureVersion` move together — the same
     pairing rule as `workerImage` + `acaDiskName` in §12. The third
     prerequisite — creating an unprivileged user namespace — is a property of
     the runtime.
     Verified to hold inside a live ACA sandbox (the exact probe
     `runBwrapSandboxProbe` runs exits 0 there), and verified NOT to hold on at
     least one local Docker daemon (NOR-364 phase 3: `bwrap: No permissions to
     create a new namespace`). So the scrub stays opt-in per host, and adding the
     packages to the image is necessary but never sufficient — confirm with the
     probe, not with `which`.
   - `CYRUS_SUBPROCESS_ENV_SCRUB` is deliberately **not** in
     `RESERVED_ENV_KEYS`: a user turning on a security control for their own
     sessions is not a hijack, and leaving it storable is what lets an operator
     enable it from their secret bundle without a router deploy. It is read from
     the **worker's own `process.env`**, never a repository `.env` — it asserts a
     property of the host, which no single repository is placed to assert.
   - **`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` is undocumented in the SDK, and the
     scrub itself has never been observed.** The flag appears nowhere in
     `sdk.d.ts` or the SDK README — only in the bundled env-var registry, read by
     the CLI binary. What HAS been verified is the bubblewrap prerequisite, which
     is not the same thing. Before anyone turns this on fleet-wide, observe a
     Bash subprocess without `ANTHROPIC_API_KEY` in its env. The SDK also exposes
     a typed, documented alternative — `options.sandbox.credentials.envVars`
     (`{name, mode: "deny" | "mask"}`), which Cyrus could set from the `sandbox`
     object `RunnerConfigBuilder` already builds, with no bubblewrap/socat/userns
     chain and macOS support. That is the likely successor to this switch.
   - **The posture is an event, not a log line.** `session.env_scrub_resolved`
     carries `cyrus.requested` / `cyrus.enabled` / `cyrus.platform` /
     `cyrus.failures`, with two saved searches in
     `infra/azure/bicep/modules/monitoring.bicep`. The whole complaint in
     NOR-412 was a control that was off with nothing to alert on, so a posture
     visible only as rendered prose reproduces the bug it fixes. Alert on
     `requested and not enabled`: every such record is a session that failed to
     start. Remember §13's bracket rule — `p["cyrus.enabled"]`, never
     `p.cyrus.enabled`, which parses as a nested lookup and silently returns
     null.

## Dependency Security Policy (MANDATE)

> **Config location (pnpm ≥10):** The root `package.json` `pnpm` field
> (`pnpm.overrides`, `pnpm.onlyBuiltDependencies`) is **no longer read** by the
> pinned pnpm (`packageManager: pnpm@10.33.1` emits a warning and ignores it).
> Both settings now live in the root **`pnpm-workspace.yaml`** (`overrides:` and
> `onlyBuiltDependencies:` top-level keys). Add/edit overrides and native-build
> allowlist entries **there**, not in `package.json`. A new native dependency
> (e.g. `better-sqlite3`) must be added to `pnpm-workspace.yaml`'s
> `onlyBuiltDependencies` list. Any overrides still sitting in `package.json`'s
> `pnpm` block are inert until migrated to `pnpm-workspace.yaml`.

Our team's mandated approach for addressing Dependabot advisories and other
transitive-dependency vulnerabilities:

1. **Prefer direct-dep bumps in the owning `package.json`.** If the vulnerable
   dep is transitively pulled in by one of *our* direct dependencies, bump that
   direct dep (in the specific package that owns it — `packages/*` or `apps/*`,
   not the root) to a version whose resolved dep graph includes the patched
   transitive. Regenerate the lockfile and let pnpm's natural resolution do the
   work.

2. **Only use workspace-level overrides in `pnpm-workspace.yaml` when a direct-dep bump cannot reach the
   vulnerable transitive.** This is the fallback for deep transitives (3+
   levels deep) whose owning direct dep has no released version that resolves
   to the patched transitive — typically because upstream hasn't released yet
   or pins its transitive too loosely for us to reach. Document the reason
   inline with a brief comment or commit message.

3. **Always clean up overrides when a future dep bump makes them redundant.**
   When you update a direct dependency (security or otherwise), check whether
   any existing override entry is now satisfied naturally by the
   new resolution. If so, **remove that override in the same change**. Verify
   with `pnpm install && pnpm audit` that the removal is safe before committing.

4. **Verify with `pnpm audit`.** After any dependency change, `pnpm audit`
   must report zero advisories. Commit the regenerated `pnpm-lock.yaml`
   alongside the `package.json` change.

Why this matters: overrides are a blunt instrument that hide the real source
of a dep. Bumping the owning direct dep is precise, gets picked up by
Dependabot, keeps our graph honest, and prevents override rot where entries
live on long after they stop doing anything.

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
- **GitHub Token Resolution**: `EdgeWorker.resolveGitHubToken()` — three-tier fallback: proxy-forwarded installation token → self-minted GitHub App token (via `GitHubAppTokenProvider`) → `GITHUB_TOKEN` PAT. Self-hosted users with a GitHub App use the middle tier; cloud/proxy users get tokens forwarded; legacy users fall back to a PAT.
- **GitHub App Token Minting**: `packages/github-event-transport/src/GitHubAppTokenProvider.ts` — signs JWTs with the App's private key and exchanges them for short-lived installation tokens. Caches tokens and refreshes 5 minutes before expiry.
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

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues (github.com/nick-boey/cyrus) via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context layout — one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
