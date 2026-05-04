# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Fixed
- **Patched two open Dependabot advisories** — Bumped `@anthropic-ai/sdk` to `^0.91.1` in `cyrus-claude-runner` to address [GHSA-p7fg-763f-g4gf](https://github.com/anthropics/anthropic-sdk-typescript/security/advisories/GHSA-p7fg-763f-g4gf) (insecure default file permissions in the local filesystem memory tool) and added a root `pnpm.overrides` entry for `>=0.91.1` to force the transitive copy bundled inside `@anthropic-ai/claude-agent-sdk` onto the patched version. Added a root `pnpm.overrides` entry `uuid: '>=14.0.0'` to address [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq) (missing buffer bounds check in v3/v5/v6) pulled in transitively via `@google/gemini-cli-core`. ([CYPACK-1170](https://linear.app/ceedar/issue/CYPACK-1170))

## [0.2.51] - 2026-04-30

### Changed
- **Updated `@anthropic-ai/claude-agent-sdk` to v0.2.123 and `@anthropic-ai/sdk` to `^0.91.0`** — Bumps the bundled Claude Code binary to v2.1.123 and the Anthropic TypeScript SDK to `^0.91.0`. This resolves a session-breaking bug where, after a parallel `Bash` tool call was cancelled following a non-zero exit on a sibling call, every subsequent `Bash` invocation in the same session would fail with `/bin/bash: line 4: /proc/self/fd/3: Permission denied` (exit 126) until the session was restarted. Other tools (`Read`, `Edit`, `Glob`, `Grep`, MCP) were unaffected. Also removes `LSP` from the `availableTools` list in `config.ts` — `LSP` is no longer shipped in Claude Code SDK v0.2.123. See [SDK changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md) for details. ([CYPACK-1152](https://linear.app/ceedar/issue/CYPACK-1152), [#1172](https://github.com/cyrusagents/cyrus/pull/1172))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.51

#### cyrus-mcp-tools
- cyrus-mcp-tools@0.2.51

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.51

#### cyrus-core
- cyrus-core@0.2.51

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.51

#### cyrus-codex-runner
- cyrus-codex-runner@0.2.51

#### cyrus-cursor-runner
- cyrus-cursor-runner@0.2.51

#### cyrus-config-updater
- cyrus-config-updater@0.2.51

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.51

#### cyrus-github-event-transport
- cyrus-github-event-transport@0.2.51

#### cyrus-gitlab-event-transport
- cyrus-gitlab-event-transport@0.2.51

#### cyrus-slack-event-transport
- cyrus-slack-event-transport@0.2.51

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.51

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.51

#### cyrus-ai (CLI)
- cyrus-ai@0.2.51

## [0.2.50] - 2026-04-30

### Added
- **Cyrus-authored PRs and MRs are now reliably tagged** — After every `gh pr create`/`gh pr edit`, `glab mr create`/`glab mr update`/`glab mr edit`, or `gt submit` command, Cyrus automatically appends a hidden `<!-- generated-by-cyrus -->` marker to the live PR/MR description if it isn't already there. This ensures the GitHub/GitLab webhook handlers can recognize Cyrus-authored PRs (so "Changes requested" events get forwarded back) even when the agent forgets to include the marker in the body it submits. ([CYPACK-1141](https://linear.app/ceedar/issue/CYPACK-1141), [#1162](https://github.com/cyrusagents/cyrus/pull/1162))
- **PR guardrail when sessions try to stop with unshipped work** — When the agent attempts to end a session, Cyrus now inspects the worktree and blocks the first stop attempt if there are uncommitted changes or commits ahead of the upstream branch, prompting the agent to commit, push, and open a pull request. Sessions with no code changes (e.g. questions, research) stop normally. ([CYPACK-1140](https://linear.app/ceedar/issue/CYPACK-1140), [#1161](https://github.com/cyrusagents/cyrus/pull/1161))
- **Remote Claude session transcripts** — When `CYRUS_APP_URL`, `CYRUS_API_KEY`, and `CYRUS_TEAM_ID` are all set, Cyrus now mirrors every Claude session transcript to the hosted Cyrus control plane (in addition to the local JSONL on disk). This lets sessions be inspected or resumed from any host, even after the ephemeral worktree is torn down. The transport speaks the Claude Agent SDK's `SessionStore` contract and passes the full 13-check behavioral conformance suite from the upstream SDK. Set `CYRUS_DISABLE_REMOTE_SESSION_STORE=1` to opt out and keep transcripts local-only. ([CYPACK-1121](https://linear.app/ceedar/issue/CYPACK-1121))
- **Optional Sentry error tracking** — When both `CYRUS_SENTRY_DSN` and `CYRUS_TEAM_ID` are set (and `CYRUS_SENTRY_DISABLED` is not), all `logger.error(...)` calls across the codebase (Claude Code/runner errors, edge-worker failures, webhook transport errors, persistence errors, uncaught exceptions, unhandled rejections) are reported to Sentry as Issues, and `WARN`/`ERROR` logs plus major lifecycle events (session started/resumed/completed/stopped, Claude session ID assigned, message emitted, webhook received, Claude query options) are forwarded to [Sentry Logs](https://docs.sentry.io/product/explore/logs/) tagged with `team_id`, `component`, and active session/issue/Claude-session identifiers — debug/info logs stay local to keep volume bounded. `CYRUS_TEAM_ID` is the single gate for both Issues and Logs: installs without a tenant tag stay silent. Set `CYRUS_SENTRY_DISABLED=1` to opt out entirely (also disables the bundled default DSN once it ships). Override the environment tag with `CYRUS_SENTRY_ENVIRONMENT`, sample errors with `CYRUS_SENTRY_SAMPLE_RATE` (0.0–1.0). Every event is enriched with a structured `cyrus` context block alongside `linear_workspace`/`deployment_id` if those env vars are set. The Sentry SDK's own internal debug output is gated separately on `CYRUS_SENTRY_DEBUG` to avoid flooding the terminal. Outgoing events **and** logs are scrubbed for token-shaped strings and sensitive keys before transmission (including breadcrumbs from console output), and grouped by a stable fingerprint so log messages with embedded IDs/paths don't fragment into one issue per occurrence. No telemetry is sent unless both env vars are present. ([CYPACK-1142](https://linear.app/ceedar/issue/CYPACK-1142))
- **New `/linear-webhook` endpoint for Linear webhooks** — The Linear webhook URL in your OAuth application can now be set to `<CYRUS_BASE_URL>/linear-webhook`. The legacy `/webhook` path continues to work for backward compatibility but is deprecated and will log a warning on first use. ([CYPACK-1119](https://linear.app/ceedar/issue/CYPACK-1119), [#1142](https://github.com/ceedaragents/cyrus/pull/1142))
- **Base branch update notifications** - When your base branch receives new commits while Cyrus is working, the active session is automatically notified to rebase, helping avoid merge conflicts. ([CYPACK-978](https://linear.app/ceedar/issue/CYPACK-978), [#1004](https://github.com/ceedaragents/cyrus/pull/1004))
- **Blocked-by dependency deferral** - Issues with unresolved `blocked_by` relationships are now automatically deferred instead of starting immediately. Cyrus posts an acknowledgment and starts work automatically when all blocking issues are resolved. User re-prompts also re-check blocking status. ([CYPACK-978](https://linear.app/ceedar/issue/CYPACK-978), [#1004](https://github.com/ceedaragents/cyrus/pull/1004))

### Changed
- **Bump OpenAI Codex SDK (`@openai/codex-sdk`) to v0.125.x** — Updates the pinned Codex integration to match the current `@openai/codex` release line bundled by that SDK (`codex` CLI **0.125.0**, including richer `codex exec`/`turn.completed` usage fields such as reasoning output tokens observed in streamed JSON sessions). Hosts relying on Cyrus’s pinned CLI via this dependency should behave the same aside from additive telemetry from Codex itself. ([CYPACK-1151](https://linear.app/ceedar/issue/CYPACK-1151), [#1171](https://github.com/cyrusagents/cyrus/pull/1171))
- Cursor sessions now run via the `@cursor/sdk` TypeScript SDK instead of spawning the `cursor-agent` CLI; permission allow/deny is now enforced via `.cursor/hooks.json` rather than `.cursor/cli.json` ([CYPACK-1149](https://linear.app/ceedar/issue/CYPACK-1149)).
- **Warm Claude sessions are now opt-in** — On startup, Cyrus no longer pre-spawns Claude Code subprocesses for the 30 most recent sessions by default. To restore the previous near-zero cold-start latency on the first message after a restart, set `CYRUS_ENABLE_WARM_SESSIONS=1` in the environment. ([CYPACK-1116](https://linear.app/ceedar/issue/CYPACK-1116))
- **Claude SDK subprocesses now exit at turn end unless warm mode is enabled** — When `CYRUS_ENABLE_WARM_SESSIONS` is unset, the streaming prompt is completed when the SDK emits a `result` message, which lets the underlying Claude Code subprocess actually exit and free its memory at the end of a turn (restores the pre-warm-sessions behavior). When `CYRUS_ENABLE_WARM_SESSIONS=1`, the streaming prompt stays open and the subprocess is kept alive so follow-up messages reuse the warm session.

### Fixed
- **Patched 6 high-severity `tar` advisories pulled in by the new `@cursor/sdk` integration** — The `@cursor/sdk` → `sqlite3` → `tar@6.2.1` chain introduced in CYPACK-1149 was flagged by Dependabot for six path-traversal/hardlink/symlink advisories (CVE-2026-24842, CVE-2026-23745, CVE-2026-26960, CVE-2026-29786, CVE-2026-31802, and a related race condition). A root `pnpm.overrides` entry now pins `tar` to `>=7.5.11` for all transitive consumers; `sqlite3`'s install script and the rest of the dep graph still resolve cleanly. ([CYPACK-1159](https://linear.app/ceedar/issue/CYPACK-1159))
- **Cursor sessions no longer crash with "Could not locate the bindings file" for `sqlite3`** — The `@cursor/sdk` switch in CYPACK-1149 introduced a transitive dependency on `sqlite3@5.1.7`, whose native `node_sqlite3.node` binding is fetched/built by an `install` lifecycle script. pnpm 10 blocks dependency lifecycle scripts by default, so fresh installs ended up with sqlite3 present but no native binding, and the first Cursor session on a clean `pnpm install` crashed at runtime. `sqlite3` is now in `pnpm.onlyBuiltDependencies` so its install script runs and the prebuilt binary lands on disk. ([CYPACK-1158](https://linear.app/ceedar/issue/CYPACK-1158), [#1174](https://github.com/cyrusagents/cyrus/pull/1174))
- **Stop signals no longer trigger "Request was aborted" errors on non-warm sessions** — Previously, every stop signal called the SDK's `query.interrupt()` regardless of whether the session was warm, which surfaced an `Error: Request was aborted` from non-warm sessions. Stop signals now branch on session state: non-warm sessions are stopped immediately on the first signal, while warm sessions retain the existing two-step interrupt-then-stop UX (interrupt on first stop, full terminate on a second stop within 10s). ([CYPACK-1145](https://linear.app/ceedar/issue/CYPACK-1145), [#1165](https://github.com/ceedaragents/cyrus/pull/1165))
- **Chat-platform replies (Slack/GitHub) are now posted when warm sessions are enabled** — Previously, `ChatSessionHandler` waited for `runner.startStreaming()` to resolve before calling the adapter's `postReply`. With `CYRUS_ENABLE_WARM_SESSIONS=1` the streaming prompt stays open across turns, so `startStreaming` never resolved and no reply was ever posted. Reply posting is now driven by `result` messages on the runner's message stream, decoupled from session termination. A FIFO queue of pending events per session ensures each turn (initial prompt, resume, or injected follow-up) is paired with its corresponding reply.
- **Improved `ToolSearch` presentation in Linear activities** — `ToolSearch` calls now post as a regular action entry (with an expandable result) instead of a bare thought. The parameter reads like "Loading tool schemas: `TaskCreate`, `TaskUpdate`" or "Searching tools for: `+linear get_issue`", and the expanded result shows the tools that were loaded (e.g. "Loaded tools: `TaskCreate`, `TaskUpdate`"). ([CYPACK-1112](https://linear.app/ceedar/issue/CYPACK-1112), [#1134](https://github.com/ceedaragents/cyrus/pull/1134))

### Fixed
- **Fixed garbled activity labels for parallel deferred-tool calls** — When Claude issued multiple `ToolSearch` (or other local deferred-tool) calls in quick succession, Linear sometimes displayed the result under a generic "Tool" label with a raw list of tool names (e.g. `Tool / mcp__digitalocean-droplets__droplet-create / ...`) instead of the proper `ToolSearch` action with a formatted result. Internal message processing is now serialized per session so the tool-use handler always registers before its matching tool-result is formatted. ([CYPACK-1112](https://linear.app/ceedar/issue/CYPACK-1112), [#1134](https://github.com/ceedaragents/cyrus/pull/1134))
- **Eliminated spurious blank lines in the Linear activity log** — Empty/whitespace-only assistant turns no longer produce blank "thought" activities, which previously appeared as an extra empty line between the "Using model: ..." notification and the first real tool call. ([CYPACK-1112](https://linear.app/ceedar/issue/CYPACK-1112), [#1134](https://github.com/ceedaragents/cyrus/pull/1134))

### Security
- **Tightened sandbox and tool permission defaults** — Claude sessions now run with stricter out-of-the-box restrictions: the OS-level sandbox enforces `denyRead: ["~/"]` + `allowRead: ["."]` (home directory blocked, worktree allowed) and `allowWrite` scoped to the session worktree only. On the tool permission side, `Read`, `Edit`, and `Write` are now narrowed to `Read(**)`, `Edit(**)`, and `Write(**)` to prevent unintended matches. Home directory files (SSH keys, credentials, etc.) are explicitly enumerated and added to `disallowedTools` at session start, working around the fact that `Read(~/**)` does not match in Claude Code's permission layer. ([#1123](https://github.com/ceedaragents/cyrus/pull/1123))
- **Addressed open security advisories** — Refreshed `pnpm-lock.yaml` so vulnerable transitive dependencies resolve to their patched versions (`protobufjs`, `path-to-regexp`, `picomatch`, `flatted`, `brace-expansion`, `yaml`, `follow-redirects`, `vite`, `hono`, `@hono/node-server`) through their existing direct-dep paths, without introducing new `pnpm.overrides` entries. ([CYPACK-1101](https://linear.app/ceedar/issue/CYPACK-1101), [#1128](https://github.com/ceedaragents/cyrus/pull/1128))

### Changed
- **Updated `@anthropic-ai/claude-agent-sdk` to v0.2.117** — Bumps the bundled Claude Code binary from v2.1.116 to v2.1.117 (parity release with no tool-list changes). Also fixes `scripts/extract-claude-tools.sh` to work with the new native binary structure introduced in SDK v0.2.113 (now resolves the platform-specific optional dependency instead of the removed `cli.js`). See [SDK changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md) for details. ([CYPACK-1120](https://linear.app/ceedar/issue/CYPACK-1120), [#1143](https://github.com/ceedaragents/cyrus/pull/1143))
- **Update `@anthropic-ai/claude-agent-sdk` to v0.2.116** — Bumps the bundled Claude Code binary from v2.1.114 to v2.1.116 (parity releases with no tool-list changes). See [SDK changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md) for details. ([CYPACK-1111](https://linear.app/ceedar/issue/CYPACK-1111), [#1133](https://github.com/ceedaragents/cyrus/pull/1133))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.50

#### cyrus-mcp-tools
- cyrus-mcp-tools@0.2.50

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.50

#### cyrus-core
- cyrus-core@0.2.50

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.50

#### cyrus-codex-runner
- cyrus-codex-runner@0.2.50

#### cyrus-cursor-runner
- cyrus-cursor-runner@0.2.50

#### cyrus-config-updater
- cyrus-config-updater@0.2.50

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.50

#### cyrus-github-event-transport
- cyrus-github-event-transport@0.2.50

#### cyrus-gitlab-event-transport
- cyrus-gitlab-event-transport@0.2.50

#### cyrus-slack-event-transport
- cyrus-slack-event-transport@0.2.50

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.50

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.50

#### cyrus-ai (CLI)
- cyrus-ai@0.2.50

## [0.2.49] - 2026-04-22

Hotfix released from the `cypack-1123` branch and forward-ported to `main`.

### Fixed
- **Claude sessions inherit the parent process environment again** — `@anthropic-ai/claude-agent-sdk` v0.2.113 reverted to no longer overlaying `process.env` onto the env passed to spawned sessions, which left Cyrus-launched Claude processes without `HOME` (and other inherited vars). That broke GPG-signed commits, `gh` CLI authentication, and any other tool that relies on a real home directory or the user's shell environment. Cyrus now spreads `process.env` explicitly when invoking the SDK so these tools work as expected. ([#1150](https://github.com/cyrusagents/cyrus/pull/1150))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.49

#### cyrus-mcp-tools
- cyrus-mcp-tools@0.2.49

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.49

#### cyrus-core
- cyrus-core@0.2.49

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.49

#### cyrus-codex-runner
- cyrus-codex-runner@0.2.49

#### cyrus-cursor-runner
- cyrus-cursor-runner@0.2.49

#### cyrus-config-updater
- cyrus-config-updater@0.2.49

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.49

#### cyrus-github-event-transport
- cyrus-github-event-transport@0.2.49

#### cyrus-gitlab-event-transport
- cyrus-gitlab-event-transport@0.2.49

#### cyrus-slack-event-transport
- cyrus-slack-event-transport@0.2.49

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.49

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.49

#### cyrus-ai (CLI)
- cyrus-ai@0.2.49

## [0.2.48] - 2026-04-20

### Changed
- **Claude Code subprocess env scrubbing is disabled** — `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` is no longer set on Claude sessions while undesirable side effects from the Linux bubblewrap sandbox are investigated. The Linux sandbox requirements precheck (added in 0.2.46) still runs and logs guidance so it can be re-enabled quickly once the side effects are resolved. ([CYPACK-1108](https://linear.app/ceedar/issue/CYPACK-1108), [#1131](https://github.com/ceedaragents/cyrus/pull/1131))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.48

#### cyrus-mcp-tools
- cyrus-mcp-tools@0.2.48

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.48

#### cyrus-core
- cyrus-core@0.2.48

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.48

#### cyrus-codex-runner
- cyrus-codex-runner@0.2.48

#### cyrus-cursor-runner
- cyrus-cursor-runner@0.2.48

#### cyrus-config-updater
- cyrus-config-updater@0.2.48

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.48

#### cyrus-github-event-transport
- cyrus-github-event-transport@0.2.48

#### cyrus-gitlab-event-transport
- cyrus-gitlab-event-transport@0.2.48

#### cyrus-slack-event-transport
- cyrus-slack-event-transport@0.2.48

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.48

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.48

#### cyrus-ai (CLI)
- cyrus-ai@0.2.48

## [0.2.47] - 2026-04-20

### Fixed
- **Runtime switches no longer require restarting Cyrus** — When `cyrus auth` rotates credentials (for example, after switching between cloud and self-host runtimes), incoming config updates from the Cyrus web app now succeed immediately instead of failing with `401 Unauthorized` until the next process restart. ([CYHOST-798](https://linear.app/ceedar/issue/CYHOST-798), [#1127](https://github.com/ceedaragents/cyrus/pull/1127))

### Changed
- **Updated `@anthropic-ai/claude-agent-sdk` to v0.2.114** — Bumps the Claude Agent SDK to the latest version. See the [claude-agent-sdk changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md) for full details. ([CYPACK-1096](https://linear.app/ceedar/issue/CYPACK-1096), [#1124](https://github.com/ceedaragents/cyrus/pull/1124))
- **Updated `@anthropic-ai/claude-agent-sdk` to v0.2.112** — Bumps the Claude Agent SDK to the latest version. See the [claude-agent-sdk changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md) for full details. ([CYPACK-1093](https://linear.app/ceedar/issue/CYPACK-1093), [#1121](https://github.com/ceedaragents/cyrus/pull/1121))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.47

#### cyrus-mcp-tools
- cyrus-mcp-tools@0.2.47

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.47

#### cyrus-core
- cyrus-core@0.2.47

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.47

#### cyrus-codex-runner
- cyrus-codex-runner@0.2.47

#### cyrus-cursor-runner
- cyrus-cursor-runner@0.2.47

#### cyrus-config-updater
- cyrus-config-updater@0.2.47

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.47

#### cyrus-github-event-transport
- cyrus-github-event-transport@0.2.47

#### cyrus-gitlab-event-transport
- cyrus-gitlab-event-transport@0.2.47

#### cyrus-slack-event-transport
- cyrus-slack-event-transport@0.2.47

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.47

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.47

#### cyrus-ai (CLI)
- cyrus-ai@0.2.47

## [0.2.46] - 2026-04-16

### Added
- **Linux sandbox requirements precheck** — On Linux hosts, Cyrus now verifies that `socat`, `bubblewrap`, and the kernel/AppArmor configuration needed to create an unprivileged user namespace are all in place before enabling Claude Code's subprocess credential scrubbing. When a requirement is missing, the session continues but sandbox mode (`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`) is left unset and resolution guidance is printed to stdout. These requirements are documented by Anthropic [here](https://code.claude.com/docs/en/sandboxing#prerequisites). The source-code of Antrhopic's sandbox runtime can be found [here](https://github.com/anthropic-experimental/sandbox-runtime). ([CYPACK-1091](https://linear.app/ceedar/issue/CYPACK-1091), [#1115](https://github.com/ceedaragents/cyrus/pull/1115))

### Changed
- **Claude Opus 4.7 is now the default model** — The `opus` model alias now resolves to `claude-opus-4-7`. No configuration change needed — existing setups using `"opus"` (the default) automatically use Opus 4.7. ([CYPACK-1090](https://linear.app/ceedar/issue/CYPACK-1090), [#1113](https://github.com/ceedaragents/cyrus/pull/1113))
- **Updated `@anthropic-ai/claude-agent-sdk` to v0.2.111 and `@anthropic-ai/sdk` to v0.90.0** — Refreshed both Anthropic SDK dependencies to their latest versions. Also updated tool allowance lists to match the new SDK: adds `LSP`, `ToolSearch`, and `PushNotification`. See the [claude-agent-sdk changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md) for full details. ([CYPACK-1090](https://linear.app/ceedar/issue/CYPACK-1090), [#1113](https://github.com/ceedaragents/cyrus/pull/1113))

### Fixed
- **Cloud runtime provisioning no longer fails on first repository** — Fixed a race condition where the edge worker tried to initialize a new repository before Linear workspace tokens were available, causing "No Linear workspace config found" errors during cloud runtime provisioning. ([CYPACK-1089](https://linear.app/ceedar/issue/CYPACK-1089), [#1112](https://github.com/ceedaragents/cyrus/pull/1112))
- **Working directory context now shows actual path** — The `<working_directory>` in agent session prompts previously showed "Will be created based on issue" instead of the actual worktree path. It now correctly displays the real workspace directory. ([CYPACK-1088](https://linear.app/ceedar/issue/CYPACK-1088), [#1110](https://github.com/ceedaragents/cyrus/pull/1110))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.46

#### cyrus-mcp-tools
- cyrus-mcp-tools@0.2.46

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.46

#### cyrus-core
- cyrus-core@0.2.46

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.46

#### cyrus-codex-runner
- cyrus-codex-runner@0.2.46

#### cyrus-cursor-runner
- cyrus-cursor-runner@0.2.46

#### cyrus-config-updater
- cyrus-config-updater@0.2.46

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.46

#### cyrus-github-event-transport
- cyrus-github-event-transport@0.2.46

#### cyrus-gitlab-event-transport
- cyrus-gitlab-event-transport@0.2.46

#### cyrus-slack-event-transport
- cyrus-slack-event-transport@0.2.46

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.46

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.46

#### cyrus-ai (CLI)
- cyrus-ai@0.2.46

## [0.2.45] - 2026-04-15

### Added
- **Customizable repos directory** — Set `CYRUS_REPOS_DIR` to control where Cyrus clones repositories, similar to the existing `CYRUS_WORKTREES_DIR` for worktrees. Defaults to `~/.cyrus/repos` when unset. ([CYPACK-1081](https://linear.app/ceedar/issue/CYPACK-1081), [#1104](https://github.com/ceedaragents/cyrus/pull/1104))
- **Network egress sandboxing** — Agent sessions can now route all network traffic through a local egress proxy for domain filtering, request logging, and per-domain header injection (credentials brokering). Enable with `sandbox.enabled: true` in `~/.cyrus/config.json`. When enabled, Bash commands are restricted to writing only within the session worktree directory — no writes to any other path on disk. Supports TLS termination for domains with transform rules, following the Vercel Sandbox Firewall interface. Sandbox network ports are passed to each Claude Agent SDK session automatically. ([CYPACK-1066](https://linear.app/ceedar/issue/CYPACK-1066), [#1095](https://github.com/ceedaragents/cyrus/pull/1095))
- **`"trusted"` network policy preset** — Set `networkPolicy.preset: "trusted"` to pre-populate the sandbox allow list with ~200 domains matching Claude Code on the web's default allowlist (package registries, version control, container registries, cloud platforms, dev tools, monitoring). Custom `allow` rules merge on top. ([CYPACK-1066](https://linear.app/ceedar/issue/CYPACK-1066))

### Changed
- **Refreshed Claude Code tool allowance lists** — Updated all tool permission presets (`availableTools`, `readOnlyTools`, `writeTools`, `getSafeTools`, `getCoordinatorTools`) to match the latest Claude Code SDK tool set (30 tools). Adds new tools like `Glob`, `Grep`, `Write`, `SendMessage`, `EnterPlanMode`, `EnterWorktree`, cron/scheduling tools, MCP resource tools, and team management tools. Removes deprecated `TodoRead`, `NotebookRead`, and `Batch`. Tool names no longer use glob patterns (`Read` instead of `Read(**)`). ([CYPACK-1067](https://linear.app/ceedar/issue/CYPACK-1067), [#1096](https://github.com/ceedaragents/cyrus/pull/1096))
- **Agent subprocess credential scrubbing** — Agent sessions set `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` so the SDK automatically strips authentication credentials (API keys, OAuth tokens) from Bash subprocess environments. Auth tokens are forwarded to the SDK process for API calls but cannot be accessed by tool-spawned commands. The parent process environment (`process.env`) is no longer inherited by agent sessions — only `PATH` and auth credentials are forwarded, alongside the repository's own `.env` variables and per-session env vars (CA certs, Cyrus flags). ([CYPACK-1066](https://linear.app/ceedar/issue/CYPACK-1066))
- **Webhook IP provenance validation** — Incoming webhooks from Linear, GitHub, and GitLab are now validated against each provider's known source IP ranges. Enabled automatically in self-hosted mode (`CYRUS_HOST_EXTERNAL=true`); can be toggled with the `WEBHOOK_IP_VALIDATION` environment variable. GitHub CIDRs are refreshed from the `/meta` API on startup. ([CYPACK-1056](https://linear.app/ceedar/issue/CYPACK-1056), [#1094](https://github.com/ceedaragents/cyrus/pull/1094))

### Fixed
- **Changelog updates no longer create duplicate entries** — The PR/MR and changelog-update skills now diff entries against the base branch instead of only the last commit, correctly detecting entries already added by the current branch and updating them in-place. ([CYPACK-1063](https://linear.app/ceedar/issue/CYPACK-1063), [#1091](https://github.com/ceedaragents/cyrus/pull/1091))
- **Agent sessions no longer fail with "executable not found" in pnpm monorepos** — The Claude Agent SDK's internal path resolution fails in pnpm's symlinked `node_modules`. Cyrus now explicitly resolves the SDK executable path using Node's module resolution, and passes `PATH` to the child process so the `node` binary can be found. ([CYPACK-1066](https://linear.app/ceedar/issue/CYPACK-1066))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.45

#### cyrus-mcp-tools
- cyrus-mcp-tools@0.2.45

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.45

#### cyrus-core
- cyrus-core@0.2.45

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.45

#### cyrus-codex-runner
- cyrus-codex-runner@0.2.45

#### cyrus-cursor-runner
- cyrus-cursor-runner@0.2.45

#### cyrus-config-updater
- cyrus-config-updater@0.2.45

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.45

#### cyrus-github-event-transport
- cyrus-github-event-transport@0.2.45

#### cyrus-gitlab-event-transport
- cyrus-gitlab-event-transport@0.2.45

#### cyrus-slack-event-transport
- cyrus-slack-event-transport@0.2.45

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.45

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.45

#### cyrus-ai (CLI)
- cyrus-ai@0.2.45

## [0.2.44] - 2026-04-10

### Fixed
- **Repository `.env` variables are now scoped per-session** — Previously, `.env` files were loaded into the EdgeWorker's `process.env`, causing environment poisoning across sessions and repositories. Variables are now parsed into an isolated object and merged only into the child subprocess env, so updated or removed values take effect immediately and one repo's `.env` cannot leak into another. ([CYPACK-1059](https://linear.app/ceedar/issue/CYPACK-1059), [#1086](https://github.com/ceedaragents/cyrus/pull/1086))
- **PR/MR interaction tips now correctly reference `@cyrusagent`** — Previously, when `GITHUB_BOT_USERNAME` or `GITLAB_BOT_USERNAME` environment variables were not set, PR/MR descriptions could show an incorrect bot username. The system now defaults to `cyrusagent`. ([CYPACK-1054](https://linear.app/ceedar/issue/CYPACK-1054), [#1082](https://github.com/ceedaragents/cyrus/pull/1082))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.44

#### cyrus-mcp-tools
- cyrus-mcp-tools@0.2.44

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.44

#### cyrus-core
- cyrus-core@0.2.44

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.44

#### cyrus-codex-runner
- cyrus-codex-runner@0.2.44

#### cyrus-cursor-runner
- cyrus-cursor-runner@0.2.44

#### cyrus-config-updater
- cyrus-config-updater@0.2.44

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.44

#### cyrus-github-event-transport
- cyrus-github-event-transport@0.2.44

#### cyrus-gitlab-event-transport
- cyrus-gitlab-event-transport@0.2.44

#### cyrus-slack-event-transport
- cyrus-slack-event-transport@0.2.44

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.44

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.44

#### cyrus-ai (CLI)
- cyrus-ai@0.2.44

## [0.2.43] - 2026-04-08

### Fixed
- **Slack chat sessions now see repositories added or removed at runtime** — Previously, Slack sessions used a stale snapshot of configured repositories from boot time, causing Cyrus to report missing access to repos that were actually configured. New sessions now always reflect the current repository configuration. ([CYPACK-1051](https://linear.app/ceedar/issue/CYPACK-1051), [#1078](https://github.com/ceedaragents/cyrus/pull/1078))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.43

#### cyrus-mcp-tools
- cyrus-mcp-tools@0.2.43

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.43

#### cyrus-core
- cyrus-core@0.2.43

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.43

#### cyrus-codex-runner
- cyrus-codex-runner@0.2.43

#### cyrus-cursor-runner
- cyrus-cursor-runner@0.2.43

#### cyrus-config-updater
- cyrus-config-updater@0.2.43

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.43

#### cyrus-github-event-transport
- cyrus-github-event-transport@0.2.43

#### cyrus-gitlab-event-transport
- cyrus-gitlab-event-transport@0.2.43

#### cyrus-slack-event-transport
- cyrus-slack-event-transport@0.2.43

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.43

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.43

#### cyrus-ai (CLI)
- cyrus-ai@0.2.43

## [0.2.42] - 2026-04-06

### Fixed
- **Bundled skills now resolve correctly for npm installs** - Skills shipped with the CLI were not found when installed via npm because symlinks were stripped during publishing. Skills are now resolved from the correct compiled path. ([CYPACK-1046](https://linear.app/ceedar/issue/CYPACK-1046), [#1073](https://github.com/ceedaragents/cyrus/pull/1073))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.42

#### cyrus-mcp-tools
- cyrus-mcp-tools@0.2.42

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.42

#### cyrus-core
- cyrus-core@0.2.42

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.42

#### cyrus-codex-runner
- cyrus-codex-runner@0.2.42

#### cyrus-cursor-runner
- cyrus-cursor-runner@0.2.42

#### cyrus-config-updater
- cyrus-config-updater@0.2.42

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.42

#### cyrus-github-event-transport
- cyrus-github-event-transport@0.2.42

#### cyrus-gitlab-event-transport
- cyrus-gitlab-event-transport@0.2.42

#### cyrus-slack-event-transport
- cyrus-slack-event-transport@0.2.42

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.42

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.42

#### cyrus-ai (CLI)
- cyrus-ai@0.2.42

## [0.2.41] - 2026-04-06

### Changed
- **Skills replace rigid procedure workflows** - Agent sessions now use flexible, customizable skills instead of fixed procedure sequences. Skills are discoverable at runtime, giving the agent more natural control over its workflow. A Stop hook ensures PRs and summaries are always created before sessions end. Users can add custom skills to `~/.cyrus/skills/`. ([CYPACK-996](https://linear.app/ceedar/issue/CYPACK-996), [#1018](https://github.com/ceedaragents/cyrus/pull/1018))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.41

#### cyrus-mcp-tools
- cyrus-mcp-tools@0.2.41

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.41

#### cyrus-core
- cyrus-core@0.2.41

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.41

#### cyrus-codex-runner
- cyrus-codex-runner@0.2.41

#### cyrus-cursor-runner
- cyrus-cursor-runner@0.2.41

#### cyrus-config-updater
- cyrus-config-updater@0.2.41

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.41

#### cyrus-github-event-transport
- cyrus-github-event-transport@0.2.41

#### cyrus-gitlab-event-transport
- cyrus-gitlab-event-transport@0.2.41

#### cyrus-slack-event-transport
- cyrus-slack-event-transport@0.2.41

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.41

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.41

#### cyrus-ai (CLI)
- cyrus-ai@0.2.41

## [0.2.40] - 2026-04-02

### Fixed
- **Slack chat sessions now use fresh Linear tokens** - The Linear MCP connection in Slack chat sessions was using a token captured once at startup, so after a daily OAuth refresh new sessions would fail to reach Linear. Chat sessions now build fresh MCP config per session, matching how issue sessions already work. ([CYPACK-1029](https://linear.app/ceedar/issue/CYPACK-1029), [#1063](https://github.com/ceedaragents/cyrus/pull/1063))
- **Logger tests updated for ISO timestamp output** - Fixed test failures caused by the ISO timestamp addition to log output in v0.2.39. Tests in `core` and `claude-runner` now correctly match the timestamped log format. ([CYPACK-1027](https://linear.app/ceedar/issue/CYPACK-1027), [#1060](https://github.com/ceedaragents/cyrus/pull/1060))

### Changed
- **Updated `@anthropic-ai/claude-agent-sdk` to v0.2.90 and `@anthropic-ai/sdk` to v0.82.0** - Upgrades from v0.2.89 / v0.81.0. v0.2.90 syncs with Claude Code v2.1.90. v0.82.0 adds structured `stop_details` to message responses and AWS Bedrock SDK API key support. See changelogs: [claude-agent-sdk](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md), [anthropic-sdk](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/CHANGELOG.md). ([CYPACK-1028](https://linear.app/ceedar/issue/CYPACK-1028), [#1062](https://github.com/ceedaragents/cyrus/pull/1062))
- **Updated `@anthropic-ai/claude-agent-sdk` to v0.2.89 and `@anthropic-ai/sdk` to v0.81.0** - Upgrades from v0.2.87 / v0.80.0. v0.2.89 adds `startup()` for ~20x faster first queries, `listSubagents()` / `getSubagentMessages()` for subagent conversation history, fixes Zod v4 schema metadata being dropped, and fixes `side_question` returning null on resume. v0.81.0 adds `.type` field to `APIError` for error kind identification. See changelogs: [claude-agent-sdk](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md), [anthropic-sdk](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/CHANGELOG.md). ([CYPACK-1026](https://linear.app/ceedar/issue/CYPACK-1026), [#1058](https://github.com/ceedaragents/cyrus/pull/1058))

### Added
- **GitHub App webhook setup for self-hosted users** - Self-hosted users can now configure GitHub App webhooks during setup. ([#1054](https://github.com/ceedaragents/cyrus/pull/1054))
- **ISO timestamps in log output** - Log lines now include ISO timestamps for easier debugging and correlation. ([#1055](https://github.com/ceedaragents/cyrus/pull/1055))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.40

#### cyrus-mcp-tools
- cyrus-mcp-tools@0.2.40

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.40

#### cyrus-core
- cyrus-core@0.2.40

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.40

#### cyrus-codex-runner
- cyrus-codex-runner@0.2.40

#### cyrus-cursor-runner
- cyrus-cursor-runner@0.2.40

#### cyrus-config-updater
- cyrus-config-updater@0.2.40

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.40

#### cyrus-github-event-transport
- cyrus-github-event-transport@0.2.40

#### cyrus-gitlab-event-transport
- cyrus-gitlab-event-transport@0.2.40

#### cyrus-slack-event-transport
- cyrus-slack-event-transport@0.2.40

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.40

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.40

#### cyrus-ai (CLI)
- cyrus-ai@0.2.40

## [0.2.39] - 2026-03-31

### Fixed
- **Linear OAuth tokens now stay fresh across long sessions** - When Linear access tokens are refreshed (at least once daily with OAuth 2.0), running sessions and services now automatically pick up the new token instead of continuing with a stale one. ([CYPACK-1024](https://linear.app/ceedar/issue/CYPACK-1024), [#1056](https://github.com/ceedaragents/cyrus/pull/1056))
- **Self-auth now works with reverse proxies on other machines** - The self-auth OAuth callback server now respects `CYRUS_HOST_EXTERNAL=true` and listens on `0.0.0.0` instead of `localhost`, matching the main server's behavior. ([#1046](https://github.com/ceedaragents/cyrus/issues/1046), [CYPACK-1017](https://linear.app/ceedar/issue/CYPACK-1017), [#1047](https://github.com/ceedaragents/cyrus/pull/1047))

### Added
- **Auto-detect base branch when adding repositories** - `cyrus self-add-repo` now automatically detects the remote's default branch instead of always using `main`. Also adds a `--base-branch` flag for manual override. ([CYPACK-1015](https://linear.app/ceedar/issue/CYPACK-1015), [#1051](https://github.com/ceedaragents/cyrus/pull/1051))

### Changed
- **Skills replace rigid procedure workflows** - Agent sessions now use flexible, customizable skills instead of fixed procedure sequences. Skills are discoverable at runtime, giving the agent more natural control over its workflow. A Stop hook ensures PRs and summaries are always created before sessions end. Users can add custom skills to `~/.cyrus/skills/`. ([CYPACK-996](https://linear.app/ceedar/issue/CYPACK-996), [#1018](https://github.com/ceedaragents/cyrus/pull/1018))
- **Renamed `cyrus self-auth` to `cyrus self-auth-linear`** - Clarifies that this command authenticates specifically with Linear OAuth. ([CYPACK-1017](https://linear.app/ceedar/issue/CYPACK-1017), [#1047](https://github.com/ceedaragents/cyrus/pull/1047))
- **Updated `@anthropic-ai/claude-agent-sdk` to v0.2.88** - Syncs with Claude Code v2.1.88. Fixes error result messages now correctly setting `is_error: true`, MCP servers no longer getting permanently stuck after a connection race, ~50% failure rate bug in `StructuredOutput` schema cache, and `ERR_STREAM_WRITE_AFTER_END` errors with single-turn queries. Also adds `includeSystemMessages` option to `getSessionMessages()` and `includeHookEvents` option for hook lifecycle messages. See SDK changelog: [claude-agent-sdk](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md). ([CYPACK-1023](https://linear.app/ceedar/issue/CYPACK-1023), [#1053](https://github.com/ceedaragents/cyrus/pull/1053))
- **Updated `@anthropic-ai/claude-agent-sdk` to v0.2.87** - Syncs with Claude Code v2.1.87 (maintenance release). See SDK changelog: [claude-agent-sdk](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md). ([CYPACK-1020](https://linear.app/ceedar/issue/CYPACK-1020), [#1050](https://github.com/ceedaragents/cyrus/pull/1050))
- **Updated `@anthropic-ai/claude-agent-sdk` to v0.2.86** - Keeps AI SDK dependency up to date. v0.2.86 adds `getContextUsage()` for token distribution visibility, makes `session_id` optional in `SDKUserMessage`, and fixes TypeScript type resolution. v0.2.85 adds `reloadPlugins()` for dynamic plugin refresh and fixes PreToolUse hooks with `"ask"` permission decisions. See SDK changelog: [claude-agent-sdk](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md). ([CYPACK-1016](https://linear.app/ceedar/issue/CYPACK-1016), [#1045](https://github.com/ceedaragents/cyrus/pull/1045))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.39

#### cyrus-mcp-tools
- cyrus-mcp-tools@0.2.39

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.39

#### cyrus-core
- cyrus-core@0.2.39

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.39

#### cyrus-codex-runner
- cyrus-codex-runner@0.2.39

#### cyrus-cursor-runner
- cyrus-cursor-runner@0.2.39

#### cyrus-config-updater
- cyrus-config-updater@0.2.39

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.39

#### cyrus-github-event-transport
- cyrus-github-event-transport@0.2.39

#### cyrus-gitlab-event-transport
- cyrus-gitlab-event-transport@0.2.39

#### cyrus-slack-event-transport
- cyrus-slack-event-transport@0.2.39

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.39

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.39

#### cyrus-ai (CLI)
- cyrus-ai@0.2.39

## [0.2.38] - 2026-03-25

### Added
- **GitLab integration with `glab` CLI support** - Cyrus now supports GitLab repositories alongside GitHub. Create merge requests, respond to MR comments, and handle review feedback using the `glab` CLI. Includes webhook support for receiving GitLab events, a dedicated setup skill (`/cyrus-setup-gitlab`), and platform-aware subroutines that automatically use `glab` commands for GitLab-hosted repos. ([#857](https://github.com/ceedaragents/cyrus/issues/857), [#1029](https://github.com/ceedaragents/cyrus/pull/1029))
- **Cyrus docs MCP available in all sessions** - Cyrus now has access to its own documentation via the Mintlify docs MCP server, enabling better self-reference and user guidance. ([CYPACK-995](https://linear.app/ceedar/issue/CYPACK-995), [#1016](https://github.com/ceedaragents/cyrus/pull/1016))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.38

#### cyrus-mcp-tools
- cyrus-mcp-tools@0.2.38

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.38

#### cyrus-core
- cyrus-core@0.2.38

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.38

#### cyrus-codex-runner
- cyrus-codex-runner@0.2.38

#### cyrus-cursor-runner
- cyrus-cursor-runner@0.2.38

#### cyrus-config-updater
- cyrus-config-updater@0.2.38

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.38

#### cyrus-github-event-transport
- cyrus-github-event-transport@0.2.38

#### cyrus-gitlab-event-transport
- cyrus-gitlab-event-transport@0.2.38

#### cyrus-slack-event-transport
- cyrus-slack-event-transport@0.2.38

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.38

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.38

#### cyrus-ai (CLI)
- cyrus-ai@0.2.38

## [0.2.37] - 2026-03-18

### Added
- **Slack sessions now support user-configured MCP tools** - Slack chat sessions can now access MCP tools from user-configured `.mcp.json` files (e.g., Supabase, Stripe, Trigger.dev), not just the built-in Linear/cyrus-tools/Slack MCPs. ([CYPACK-982](https://linear.app/ceedar/issue/CYPACK-982), [#1006](https://github.com/ceedaragents/cyrus/pull/1006))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.37

#### cyrus-mcp-tools
- cyrus-mcp-tools@0.2.37

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.37

#### cyrus-core
- cyrus-core@0.2.37

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.37

#### cyrus-codex-runner
- cyrus-codex-runner@0.2.37

#### cyrus-cursor-runner
- cyrus-cursor-runner@0.2.37

#### cyrus-config-updater
- cyrus-config-updater@0.2.37

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.37

#### cyrus-github-event-transport
- cyrus-github-event-transport@0.2.37

#### cyrus-slack-event-transport
- cyrus-slack-event-transport@0.2.37

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.37

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.37

#### cyrus-ai (CLI)
- cyrus-ai@0.2.37

## [0.2.36] - 2026-03-17

### Added
- **Automatic worktree cleanup on issue completion or deletion** - When a Linear issue moves to Done, Cancelled, or is deleted, worktrees are automatically deleted and any active sessions are stopped. Handles both single-repo and multi-repo layouts. ([CYPACK-961](https://linear.app/ceedar/issue/CYPACK-961), [#982](https://github.com/ceedaragents/cyrus/pull/982))

### Fixed
- **Worktree recreation after issue reopened** - Fixed a bug where worktrees were not recreated when an issue was re-prompted after being moved to Done/Cancelled. Stale git worktree entries from a previous cleanup could prevent fresh worktree creation. ([CYPACK-961](https://linear.app/ceedar/issue/CYPACK-961), [#982](https://github.com/ceedaragents/cyrus/pull/982))
- **Self-hosted onboarding improvements** - Fixed `-l` routing labels flag not working with `cyrus self-add-repo`, idle mode now shows `cyrus self-add-repo` guidance instead of cloud URL for self-hosted users, and `cyrus self-auth` error messages now correctly point to `~/.cyrus/.env` instead of `.zshrc`. ([CYPACK-967](https://linear.app/ceedar/issue/CYPACK-967), [#991](https://github.com/ceedaragents/cyrus/pull/991))
- **Security vulnerabilities resolved** - Fixed all Dependabot security alerts (1 critical, 20 high, 11 moderate, 4 low) by updating transitive dependency versions for packages including simple-git, undici, hono, minimatch, rollup, and others. ([CYPACK-973](https://linear.app/ceedar/issue/CYPACK-973), [#1000](https://github.com/ceedaragents/cyrus/pull/1000))

### Changed
- **PR descriptions now include interaction tips** - Pull requests created by Cyrus now include a tip explaining how to @ mention the bot (configurable via `GITHUB_BOT_USERNAME`) for inline responses and how to submit "changes requested" reviews for batch feedback. ([CYPACK-974](https://linear.app/ceedar/issue/CYPACK-974), [#1001](https://github.com/ceedaragents/cyrus/pull/1001))
- **Co-authored-by attribution disabled** - Git commits no longer include the "Co-Authored-By: Claude" trailer. ([CYPACK-974](https://linear.app/ceedar/issue/CYPACK-974), [#1001](https://github.com/ceedaragents/cyrus/pull/1001))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.36

#### cyrus-mcp-tools
- cyrus-mcp-tools@0.2.36

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.36

#### cyrus-core
- cyrus-core@0.2.36

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.36

#### cyrus-codex-runner
- cyrus-codex-runner@0.2.36

#### cyrus-cursor-runner
- cyrus-cursor-runner@0.2.36

#### cyrus-config-updater
- cyrus-config-updater@0.2.36

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.36

#### cyrus-github-event-transport
- cyrus-github-event-transport@0.2.36

#### cyrus-slack-event-transport
- cyrus-slack-event-transport@0.2.36

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.36

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.36

#### cyrus-ai (CLI)
- cyrus-ai@0.2.36

## [0.2.35] - 2026-03-16

### Fixed
- **OAuth token refresh no longer stops working after first expiry** - Fixed a bug where the OAuth token refresh mechanism would permanently stop refreshing after the first successful refresh, causing all Linear API calls to fail ~24 hours later. Subsequent token expirations now correctly trigger fresh refreshes. ([CYPACK-963](https://linear.app/ceedar/issue/CYPACK-963), [#986](https://github.com/ceedaragents/cyrus/pull/986))
- **Self-auth no longer modifies repositories or shows confusing messages** - `cyrus self-auth` now only saves workspace credentials and no longer auto-links repositories. Shows "Saved credentials for workspace: \<name\>" and guides users to run `cyrus self-add-repo` when no repos exist. Resolves [#716](https://github.com/ceedaragents/cyrus/issues/716). ([CYPACK-964](https://linear.app/ceedar/issue/CYPACK-964), [#988](https://github.com/ceedaragents/cyrus/pull/988))
- **Linear webhook signature verification more reliable** - Webhook signature verification now uses the raw request body bytes instead of re-serializing JSON, preventing intermittent HMAC failures caused by key ordering or whitespace differences.

### Added
- **Routing labels default when adding repos** - `cyrus self-add-repo` now automatically sets routing labels to the repository name. Use `-l custom,labels` to override with custom comma-separated labels. ([CYPACK-963](https://linear.app/ceedar/issue/CYPACK-963), [#986](https://github.com/ceedaragents/cyrus/pull/986))
- **Cloudflare tunnel auto-starts during self-auth** - Running `cyrus self-auth` now automatically starts a Cloudflare tunnel, so webhooks can reach the local agent immediately after authentication. ([#952](https://github.com/ceedaragents/cyrus/pull/952))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.35

#### cyrus-mcp-tools
- cyrus-mcp-tools@0.2.35

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.35

#### cyrus-core
- cyrus-core@0.2.35

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.35

#### cyrus-codex-runner
- cyrus-codex-runner@0.2.35

#### cyrus-cursor-runner
- cyrus-cursor-runner@0.2.35

#### cyrus-config-updater
- cyrus-config-updater@0.2.35

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.35

#### cyrus-github-event-transport
- cyrus-github-event-transport@0.2.35

#### cyrus-slack-event-transport
- cyrus-slack-event-transport@0.2.35

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.35

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.35

#### cyrus-ai (CLI)
- cyrus-ai@0.2.35

## [0.2.34] - 2026-03-13

### Fixed
- **Slack-created issues no longer land in Triage** - Issues created from Slack conversations now default to "Backlog" status instead of potentially being set to "Triage". ([CYPACK-957](https://linear.app/ceedar/issue/CYPACK-957), [#978](https://github.com/ceedaragents/cyrus/pull/978))
- **Issue updates no longer trigger duplicate runs** - When a Linear issue title or description was updated, all idle sessions for that issue were resumed, causing multiple concurrent runs. Issue updates are now only delivered to currently running sessions via streaming input; idle sessions are no longer resumed. Duplicate webhooks are also deduplicated. ([CYPACK-954](https://linear.app/ceedar/issue/CYPACK-954), [#977](https://github.com/ceedaragents/cyrus/pull/977))

### Added
- **Multi-repo routing** - A single Linear issue can now be routed to multiple repositories. Supported syntax: `[repo=frontend]` and `[repo=backend]` as separate tags, `repo=frontend,backend` or `repos=frontend,backend` as comma-separated lists, `repo=frontend#develop` or `[repo=frontend#release/v2]` for base branch overrides, and label-based routing that matches multiple repos when their routing labels overlap. Each matched repository gets its own worktree subfolder and git context within the same session, with per-repository branch names, MCP configs, and tool permissions. ([CYPACK-911](https://linear.app/ceedar/issue/CYPACK-911), [#955](https://github.com/ceedaragents/cyrus/pull/955), [#959](https://github.com/ceedaragents/cyrus/pull/959), [#960](https://github.com/ceedaragents/cyrus/pull/960), [#961](https://github.com/ceedaragents/cyrus/pull/961), [#962](https://github.com/ceedaragents/cyrus/pull/962), [#963](https://github.com/ceedaragents/cyrus/pull/963), [#964](https://github.com/ceedaragents/cyrus/pull/964), [#965](https://github.com/ceedaragents/cyrus/pull/965))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.34

#### cyrus-mcp-tools
- cyrus-mcp-tools@0.2.34

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.34

#### cyrus-core
- cyrus-core@0.2.34

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.34

#### cyrus-codex-runner
- cyrus-codex-runner@0.2.34

#### cyrus-cursor-runner
- cyrus-cursor-runner@0.2.34

#### cyrus-config-updater
- cyrus-config-updater@0.2.34

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.34

#### cyrus-github-event-transport
- cyrus-github-event-transport@0.2.34

#### cyrus-slack-event-transport
- cyrus-slack-event-transport@0.2.34

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.34

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.34

#### cyrus-ai (CLI)
- cyrus-ai@0.2.34

## [0.2.33] - 2026-03-10

### Fixed
- **MCP config files crashing ClaudeRunner sessions** - File-loaded MCP server configs (`.mcp.json`, `mcp-*.json`) that omit the `type` field for URL-based servers no longer crash sessions with 0 messages. ClaudeRunner now infers `type: "http"` when a `url` is present. ([#966](https://github.com/ceedaragents/cyrus/pull/966))

### Added
- **Real MCP connection testing** - The MCP test endpoint now performs actual SDK connections (stdio process spawn or HTTP/SSE) and returns discovered tools, replacing the previous placeholder response. ([#966](https://github.com/ceedaragents/cyrus/pull/966))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.33

#### cyrus-mcp-tools
- cyrus-mcp-tools@0.2.33

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.33

#### cyrus-core
- cyrus-core@0.2.33

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.33

#### cyrus-codex-runner
- cyrus-codex-runner@0.2.33

#### cyrus-cursor-runner
- cyrus-cursor-runner@0.2.33

#### cyrus-config-updater
- cyrus-config-updater@0.2.33

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.33

#### cyrus-github-event-transport
- cyrus-github-event-transport@0.2.33

#### cyrus-slack-event-transport
- cyrus-slack-event-transport@0.2.33

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.33

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.33

#### cyrus-ai (CLI)
- cyrus-ai@0.2.33

## [0.2.32] - 2026-03-10

### Fixed
- **Orchestrator sub-issue results not reaching parent** - Sub-issue completion results are now correctly written back to the parent orchestrator issue. This regression was introduced in v0.2.22 by the GlobalSessionRegistry refactor (CYPACK-724), which changed the parent session lookup to read from `globalSessionRegistry` without updating the write path to match. ([CYPACK-922](https://linear.app/ceedar/issue/CYPACK-922), [#957](https://github.com/ceedaragents/cyrus/pull/957))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.32

#### cyrus-mcp-tools
- cyrus-mcp-tools@0.2.32

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.32

#### cyrus-core
- cyrus-core@0.2.32

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.32

#### cyrus-codex-runner
- cyrus-codex-runner@0.2.32

#### cyrus-cursor-runner
- cyrus-cursor-runner@0.2.32

#### cyrus-config-updater
- cyrus-config-updater@0.2.32

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.32

#### cyrus-github-event-transport
- cyrus-github-event-transport@0.2.32

#### cyrus-slack-event-transport
- cyrus-slack-event-transport@0.2.32

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.32

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.32

#### cyrus-ai (CLI)
- cyrus-ai@0.2.32

## [0.2.31] - 2026-03-09

### Fixed
- **Rate limit event handling** - Rate limit events from Claude are now properly handled instead of producing "Unknown message type" warnings in logs. ([CYPACK-895](https://linear.app/ceedar/issue/CYPACK-895), [#946](https://github.com/ceedaragents/cyrus/pull/946))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.31

#### cyrus-mcp-tools
- cyrus-mcp-tools@0.2.31

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.31

#### cyrus-core
- cyrus-core@0.2.31

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.31

#### cyrus-codex-runner
- cyrus-codex-runner@0.2.31

#### cyrus-cursor-runner
- cyrus-cursor-runner@0.2.31

#### cyrus-config-updater
- cyrus-config-updater@0.2.31

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.31

#### cyrus-github-event-transport
- cyrus-github-event-transport@0.2.31

#### cyrus-slack-event-transport
- cyrus-slack-event-transport@0.2.31

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.31

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.31

#### cyrus-ai (CLI)
- cyrus-ai@0.2.31

## [0.2.30] - 2026-03-05

### Fixed
- **Chat session repository context and git pull guidance** - Chat sessions now receive read-only access to all configured repository paths and include explicit `git pull` instructions in their system prompt when inspecting repository source code. ([CYPACK-891](https://linear.app/ceedar/issue/CYPACK-891), [#942](https://github.com/ceedaragents/cyrus/pull/942))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.30

#### cyrus-mcp-tools
- cyrus-mcp-tools@0.2.30

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.30

#### cyrus-core
- cyrus-core@0.2.30

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.30

#### cyrus-codex-runner
- cyrus-codex-runner@0.2.30

#### cyrus-cursor-runner
- cyrus-cursor-runner@0.2.30

#### cyrus-config-updater
- cyrus-config-updater@0.2.30

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.30

#### cyrus-github-event-transport
- cyrus-github-event-transport@0.2.30

#### cyrus-slack-event-transport
- cyrus-slack-event-transport@0.2.30

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.30

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.30

#### cyrus-ai (CLI)
- cyrus-ai@0.2.30

## [0.2.29] - 2026-03-05

### Fixed
- **Slack thread context now includes the agent's own messages** - Follow-up sessions (especially after switching runner types) no longer lose conversation history. The agent's previous replies are now included in thread context and labeled as "assistant (you)" so the new runner understands conversation roles.

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.29

#### cyrus-mcp-tools
- cyrus-mcp-tools@0.2.29

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.29

#### cyrus-core
- cyrus-core@0.2.29

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.29

#### cyrus-codex-runner
- cyrus-codex-runner@0.2.29

#### cyrus-cursor-runner
- cyrus-cursor-runner@0.2.29

#### cyrus-config-updater
- cyrus-config-updater@0.2.29

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.29

#### cyrus-github-event-transport
- cyrus-github-event-transport@0.2.29

#### cyrus-slack-event-transport
- cyrus-slack-event-transport@0.2.29

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.29

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.29

#### cyrus-ai (CLI)
- cyrus-ai@0.2.29

## [0.2.28] - 2026-03-04

### Fixed
- **Webhook verification mode now updates at runtime** - When `SLACK_SIGNING_SECRET` or `GITHUB_WEBHOOK_SECRET` environment variables are added after the process starts (along with `CYRUS_HOST_EXTERNAL=true`), Cyrus now automatically switches from proxied to direct webhook verification without requiring a restart. ([CYPACK-884](https://linear.app/ceedar/issue/CYPACK-884), [#934](https://github.com/ceedaragents/cyrus/pull/934))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.28

#### cyrus-mcp-tools
- cyrus-mcp-tools@0.2.28

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.28

#### cyrus-core
- cyrus-core@0.2.28

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.28

#### cyrus-codex-runner
- cyrus-codex-runner@0.2.28

#### cyrus-cursor-runner
- cyrus-cursor-runner@0.2.28

#### cyrus-config-updater
- cyrus-config-updater@0.2.28

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.28

#### cyrus-github-event-transport
- cyrus-github-event-transport@0.2.28

#### cyrus-slack-event-transport
- cyrus-slack-event-transport@0.2.28

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.28

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.28

#### cyrus-ai (CLI)
- cyrus-ai@0.2.28

## [0.2.27] - 2026-03-04 ([#933](https://github.com/ceedaragents/cyrus/pull/933))

### Added
- **PR change request handling** - When a reviewer requests changes on a PR created by Cyrus, the agent now automatically acknowledges the review and starts working on the requested changes. Supports both summary-level and line-level review comments. ([CYPACK-842](https://linear.app/ceedar/issue/CYPACK-842), [#896](https://github.com/ceedaragents/cyrus/pull/896))
- **Direct Slack webhook verification for self-hosted deployments** - Cyrus can now verify Slack webhooks directly using HMAC-SHA256 signature verification when `SLACK_SIGNING_SECRET` is set, removing the need for the CYHOST proxy in self-hosted environments. Thanks to [@aniravi24](https://github.com/aniravi24) ([#829](https://github.com/ceedaragents/cyrus/pull/829))
- **GitHub bot mention filtering** - GitHub webhook handler now respects `GITHUB_BOT_USERNAME` to only trigger on `@bot` mentions and ignore its own comments, preventing infinite loops in self-hosted setups. Thanks to [@aniravi24](https://github.com/aniravi24) ([#829](https://github.com/ceedaragents/cyrus/pull/829))
- **Smarter Slack thread context** - Other bots' messages (Sentry, CI, GitHub notifications) are now preserved in Slack thread context instead of being filtered out. Only the bot's own messages are excluded. Thanks to [@aniravi24](https://github.com/aniravi24) ([#829](https://github.com/ceedaragents/cyrus/pull/829))

### Fixed
- **Slack bot token availability after runtime switch** - Fixed Slack bot token not being available when switching from cloud to self-host runtime. The token is now resolved at usage time with a fallback to `process.env`, handling cases where the env update arrives after the first webhook. ([CYPACK-842](https://linear.app/ceedar/issue/CYPACK-842), [#896](https://github.com/ceedaragents/cyrus/pull/896))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.27

#### cyrus-mcp-tools
- cyrus-mcp-tools@0.2.27

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.27

#### cyrus-core
- cyrus-core@0.2.27

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.27

#### cyrus-codex-runner
- cyrus-codex-runner@0.2.27

#### cyrus-cursor-runner
- cyrus-cursor-runner@0.2.27

#### cyrus-config-updater
- cyrus-config-updater@0.2.27

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.27

#### cyrus-github-event-transport
- cyrus-github-event-transport@0.2.27

#### cyrus-slack-event-transport
- cyrus-slack-event-transport@0.2.27

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.27

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.27

#### cyrus-ai (CLI)
- cyrus-ai@0.2.27

## [0.2.26] - 2026-02-28 ([#918](https://github.com/ceedaragents/cyrus/pull/918))

### Changed
- **Updated Claude SDK dependencies** - project configs & auto memory are now shared across git worktrees of the same repository, so Claude's persistent memory works consistently across all Cyrus worktrees. Updated `@anthropic-ai/claude-agent-sdk` to v0.2.63 and `@anthropic-ai/sdk` to v0.78.0. See [claude-agent-sdk changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md) for details. ([CYPACK-859](https://linear.app/ceedar/issue/CYPACK-859), [#917](https://github.com/ceedaragents/cyrus/pull/917))

### Fixed
- **Cursor runs no longer fail on version mismatches** - Cyrus no longer blocks Cursor sessions when the installed `cursor-agent` version differs from a previously tested version, and the `CYRUS_CURSOR_AGENT_VERSION` override is no longer needed. ([CYPACK-857](https://linear.app/ceedar/issue/CYPACK-857/remove-the-requirement-that-throws-this-error), [#915](https://github.com/ceedaragents/cyrus/pull/915))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.26

#### cyrus-mcp-tools
- cyrus-mcp-tools@0.2.26

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.26

#### cyrus-core
- cyrus-core@0.2.26

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.26

#### cyrus-codex-runner
- cyrus-codex-runner@0.2.26

#### cyrus-cursor-runner
- cyrus-cursor-runner@0.2.26

#### cyrus-config-updater
- cyrus-config-updater@0.2.26

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.26

#### cyrus-github-event-transport
- cyrus-github-event-transport@0.2.26

#### cyrus-slack-event-transport
- cyrus-slack-event-transport@0.2.26

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.26

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.26

#### cyrus-ai (CLI)
- cyrus-ai@0.2.26

## [0.2.25] - 2026-02-27

### Fixed
- **Default runner config now applies on hot-reload** - Changing `defaultRunner`, model defaults, or other global settings in `~/.cyrus/config.json` while Cyrus is running now takes effect immediately, instead of being ignored until restart. ([CYPACK-856](https://linear.app/ceedar/issue/CYPACK-856), [#907](https://github.com/ceedaragents/cyrus/pull/907))
- **Codex runner no longer fails during issue classification** - When `defaultRunner` is set to `codex`, the ProcedureAnalyzer classification step no longer crashes with a reasoning effort error. Also uses structured outputs for more reliable classification responses. ([CYPACK-856](https://linear.app/ceedar/issue/CYPACK-856), [#907](https://github.com/ceedaragents/cyrus/pull/907))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.25

#### cyrus-mcp-tools
- cyrus-mcp-tools@0.2.25

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.25

#### cyrus-core
- cyrus-core@0.2.25

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.25

#### cyrus-codex-runner
- cyrus-codex-runner@0.2.25

#### cyrus-cursor-runner
- cyrus-cursor-runner@0.2.25

#### cyrus-config-updater
- cyrus-config-updater@0.2.25

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.25

#### cyrus-github-event-transport
- cyrus-github-event-transport@0.2.25

#### cyrus-slack-event-transport
- cyrus-slack-event-transport@0.2.25

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.25

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.25

#### cyrus-ai (CLI)
- cyrus-ai@0.2.25

## [0.2.24] - 2026-02-26

### Fixed
- **Sessions no longer appear stuck after restart** - When the system restarts or migrates, user prompts, stop signals, and other interactions that target older sessions are now recovered instead of silently dropped. Users will see clear feedback instead of a hanging state. ([CYPACK-852](https://linear.app/ceedar/issue/CYPACK-852), [#905](https://github.com/ceedaragents/cyrus/pull/905))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.24

#### cyrus-mcp-tools
- cyrus-mcp-tools@0.2.24

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.24

#### cyrus-core
- cyrus-core@0.2.24

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.24

#### cyrus-codex-runner
- cyrus-codex-runner@0.2.24

#### cyrus-cursor-runner
- cyrus-cursor-runner@0.2.24

#### cyrus-config-updater
- cyrus-config-updater@0.2.24

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.24

#### cyrus-github-event-transport
- cyrus-github-event-transport@0.2.24

#### cyrus-slack-event-transport
- cyrus-slack-event-transport@0.2.24

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.24

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.24

#### cyrus-ai (CLI)
- cyrus-ai@0.2.24

## [0.2.23] - 2026-02-25

### Fixed
- **`defaultRunner` config setting now works correctly** - Setting `"defaultRunner": "codex"` (or `"gemini"` / `"cursor"`) in `~/.cyrus/config.json` now properly routes issues without runner-specific labels to the configured default runner, instead of always falling back to Claude. ([CYPACK-838](https://linear.app/ceedar/issue/CYPACK-838), [#892](https://github.com/ceedaragents/cyrus/pull/892))

### Added
- **Assignee attribution on PRs** - PR descriptions now include assignee attribution at the top. When the assignee has a linked GitHub account, they are @mentioned for a GitHub notification. When no GitHub account is linked, the assignee's Linear profile is linked instead, ensuring an audit trail for all PRs. ([CYPACK-843](https://linear.app/ceedar/issue/CYPACK-843), [#895](https://github.com/ceedaragents/cyrus/pull/895))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.23

#### cyrus-mcp-tools
- cyrus-mcp-tools@0.2.23

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.23

#### cyrus-core
- cyrus-core@0.2.23

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.23

#### cyrus-codex-runner
- cyrus-codex-runner@0.2.23

#### cyrus-cursor-runner
- cyrus-cursor-runner@0.2.23

#### cyrus-config-updater
- cyrus-config-updater@0.2.23

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.23

#### cyrus-github-event-transport
- cyrus-github-event-transport@0.2.23

#### cyrus-slack-event-transport
- cyrus-slack-event-transport@0.2.23

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.23

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.23

#### cyrus-ai (CLI)
- cyrus-ai@0.2.23

## [0.2.22] - 2026-02-20

### Added
- **Slack MCP tools available in agent sessions** - When the `SLACK_BOT_TOKEN` environment variable is set, Slack MCP tools (`mcp__slack`) are now automatically available in Linear and Slack sessions, enabling agents to read channels, search messages, and interact with Slack workspaces. ([CYPACK-832](https://linear.app/ceedar/issue/CYPACK-832), [#884](https://github.com/ceedaragents/cyrus/pull/884))
- **Subroutine transition status messages** - Cyrus now posts a status update to the Linear timeline when transitioning between sub-procedures (e.g., "Running tests, linting, and type checking...", "Creating summary..."), so users can see what Cyrus is doing instead of the session appearing to hang. ([CYPACK-835](https://linear.app/ceedar/issue/CYPACK-835), [#887](https://github.com/ceedaragents/cyrus/pull/887))
- **Configurable default runner** - The default agent harness is now configurable via `defaultRunner` in `config.json` (values: `"claude"`, `"gemini"`, `"codex"`, `"cursor"`) instead of always defaulting to Claude. When only one API key is set (Claude, Gemini, Codex, or Cursor), that runner is auto-detected as the default. When multiple keys are present, set `defaultRunner` to choose which one is used for new sessions. The setting is also updateable via the config update endpoint. ([CYPACK-826](https://linear.app/ceedar/issue/CYPACK-826), [#878](https://github.com/ceedaragents/cyrus/pull/878))
- GitHub PR comment support: Cyrus can now be triggered by `@cyrusagent` mentions on GitHub pull request comments, creating sessions and posting replies directly on PRs. ([CYPACK-772](https://linear.app/ceedar/issue/CYPACK-772), [#820](https://github.com/ceedaragents/cyrus/pull/820))
- Slack integration: Cyrus can now receive `@mention` webhooks from Slack channels and threads, enabling Slack as a new platform for triggering agent sessions. ([CYPACK-807](https://linear.app/ceedar/issue/CYPACK-807), [#861](https://github.com/ceedaragents/cyrus/pull/861))

### Changed
- **Slack responses now use proper mrkdwn formatting** - Slack sessions now instruct the agent to use Slack's native mrkdwn syntax instead of standard Markdown, ensuring bold, italic, links, and code blocks render correctly in Slack messages. ([CYPACK-834](https://linear.app/ceedar/issue/CYPACK-834), [#886](https://github.com/ceedaragents/cyrus/pull/886))
- **OpenAI tools now auto-detected from environment** - GPT Image and Sora video generation tools are now automatically available when the `OPENAI_API_KEY` environment variable is set, instead of requiring `openaiApiKey` in repository config. The `openaiApiKey` and `openaiOutputDirectory` config fields have been removed. ([CYPACK-831](https://linear.app/ceedar/issue/CYPACK-831), [#883](https://github.com/ceedaragents/cyrus/pull/883))
- **Updated Claude SDK dependencies** - Updated `@anthropic-ai/claude-agent-sdk` to v0.2.47 and `@anthropic-ai/sdk` to v0.77.0, adding Claude Sonnet 4.6 support, new `promptSuggestion()` method, and improved memory usage for large shell outputs. See [claude-agent-sdk changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md) for details. ([CYPACK-827](https://linear.app/ceedar/issue/CYPACK-827), [#880](https://github.com/ceedaragents/cyrus/pull/880))
- Slack bot token is now read exclusively from the `SLACK_BOT_TOKEN` environment variable. The `X-Slack-Bot-Token` HTTP header is no longer supported. ([CYPACK-824](https://linear.app/ceedar/issue/CYPACK-824), [#876](https://github.com/ceedaragents/cyrus/pull/876))
- Slack agent sessions now run in transient empty directories instead of git worktrees, and subsequent @mentions in the same thread share the same session context. ([CYPACK-815](https://linear.app/ceedar/issue/CYPACK-815), [#868](https://github.com/ceedaragents/cyrus/pull/868))
- **Agent and model selectors now work across Claude, Gemini, and Codex** - You can now set runner and model directly in issue descriptions using `[agent=claude|gemini|codex]` and `[model=<model-name>]`. This is not Codex-only: selectors apply to all supported runners. `[agent=...]` explicitly selects the runner, `[model=...]` selects the model and can infer runner family, and description tags take precedence over labels. ([#850](https://github.com/ceedaragents/cyrus/pull/850))
- **Codex tool activity is now visible in Linear sessions** - Codex runs now emit tool lifecycle activity (including command execution, file edits, web fetch/search, MCP tool calls, and todo updates) so activity streams show execution details instead of only final output. ([#850](https://github.com/ceedaragents/cyrus/pull/850))
- **Codex todo output now renders as proper checklists** - Todo items are now formatted as markdown task lists (`- [ ]` and `- [x]`) for correct checklist rendering in Linear. ([#850](https://github.com/ceedaragents/cyrus/pull/850))
- **Major new feature: Cursor agent harness support** - Cyrus now supports Cursor as a first-class agent option. To use it, set `[agent=cursor]` in the issue description or apply a `cursor` issue label; either selector runs end-to-end with the Cursor runner and posts the final response back to the issue thread. Cursor runs now map Cyrus tool permissions into project-level Cursor CLI permissions, pre-enable configured MCP servers before run, and refresh permissions between subroutines so permission changes take effect without restarting the issue flow. Cursor sandbox is enabled by default for tool execution isolation; set `CYRUS_SANDBOX=disabled` to disable. Before each run, Cyrus validates that the installed `cursor-agent` version matches the tested version; a mismatch posts an error to Linear. Set `CYRUS_CURSOR_AGENT_VERSION` to your installed version to override. Assembled cursor-agent CLI args are now logged to console and session log files for debugging. Codex default runner model is now `gpt-5.3-codex` (configurable via `codexDefaultModel`). ([CYPACK-804](https://linear.app/ceedar/issue/CYPACK-804), [#858](https://github.com/ceedaragents/cyrus/pull/858))
- **Cyrus MCP tools now run on the built-in server endpoint with authenticated Codex access** - Cyrus tools are now served via Fastify MCP on the same configured server port, cyrus-tools MCP requests require `Authorization: Bearer <CYRUS_API_KEY>`, and Codex now forwards configured MCP HTTP auth headers correctly so authenticated MCP servers initialize successfully. ([CYPACK-817](https://linear.app/ceedar/issue/CYPACK-817), [#870](https://github.com/ceedaragents/cyrus/pull/870))

### Fixed
- Summary subroutines now properly disable all tools including MCP tools like Linear's create_comment ([#808](https://github.com/ceedaragents/cyrus/pull/808))
- Procedures no longer fail when a subroutine exits with an error (e.g., hitting the max turns limit). Cyrus now recovers by using the last successful subroutine's result, allowing the workflow to continue to completion instead of stopping mid-procedure ([#818](https://github.com/ceedaragents/cyrus/pull/818))
- **Codex usage limit errors now display full message in Linear** - When Codex hits usage limits or other turn.failed errors, the actual error message is now posted to Linear agent activity instead of a generic message. ([CYPACK-804](https://linear.app/ceedar/issue/CYPACK-804), [#858](https://github.com/ceedaragents/cyrus/pull/858))
- **Cursor project .cursor/cli.json is now backed up and restored** - CursorRunner no longer overwrites the project's `.cursor/cli.json`. It temporarily renames the existing file before writing Cyrus permissions, then restores the original when the session ends. ([CYPACK-804](https://linear.app/ceedar/issue/CYPACK-804), [#858](https://github.com/ceedaragents/cyrus/pull/858))
- **Cursor API key no longer in CLI args or logs** - The Cursor API key is now passed only via the `CURSOR_API_KEY` environment variable, so it never appears in spawn logs or terminal output. The `--force` option has also been removed from cursor-agent invocations. ([CYPACK-804](https://linear.app/ceedar/issue/CYPACK-804), [#858](https://github.com/ceedaragents/cyrus/pull/858))
- **Cursor completed todos now display as checked in Linear** - Cursor API uses `TODO_STATUS_COMPLETED` for completed todo items; the formatter now recognizes this so completed items render as `- [x]` instead of `- [ ]` in Linear activity. ([CYPACK-804](https://linear.app/ceedar/issue/CYPACK-804), [#858](https://github.com/ceedaragents/cyrus/pull/858))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.22

#### cyrus-mcp-tools
- cyrus-mcp-tools@0.2.22

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.22

#### cyrus-core
- cyrus-core@0.2.22

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.22

#### cyrus-codex-runner
- cyrus-codex-runner@0.2.22

#### cyrus-cursor-runner
- cyrus-cursor-runner@0.2.22

#### cyrus-config-updater
- cyrus-config-updater@0.2.22

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.22

#### cyrus-github-event-transport
- cyrus-github-event-transport@0.2.22

#### cyrus-slack-event-transport
- cyrus-slack-event-transport@0.2.22

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.22

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.22

#### cyrus-ai (CLI)
- cyrus-ai@0.2.22

## [0.2.21] - 2026-02-09

### Changed
- **Updated Claude SDK dependencies** - Updated `@anthropic-ai/claude-agent-sdk` to v0.2.34 and `@anthropic-ai/sdk` to v0.73.0. See [claude-agent-sdk changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md#v0234) for details. ([CYPACK-788](https://linear.app/ceedar/issue/CYPACK-788), [#837](https://github.com/ceedaragents/cyrus/pull/837))
- **Improved task and tool activity display** - Task creation now shows as concise checklist items instead of verbose multi-line entries, task status updates display the task name with status emoji, and tool search/background task output activities are now cleanly formatted. ([CYPACK-795](https://linear.app/ceedar/issue/CYPACK-795), [#846](https://github.com/ceedaragents/cyrus/pull/846))
- **Task status updates now show task descriptions** - Task update and task detail activities now display the task subject alongside the task number (e.g., "Task #3 — Fix login bug") instead of just the number. ([CYPACK-797](https://linear.app/ceedar/issue/CYPACK-797), [#847](https://github.com/ceedaragents/cyrus/pull/847))

### Fixed
- **Procedures no longer fail when a subroutine exits with an error** - When a single-turn subroutine hits the max turns limit, Cyrus now recovers by using the last successful subroutine's result, allowing the workflow to continue to completion instead of stopping mid-procedure. ([CYPACK-792](https://linear.app/ceedar/issue/CYPACK-792), [#843](https://github.com/ceedaragents/cyrus/pull/843))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.21

#### cyrus-config-updater
- cyrus-config-updater@0.2.21

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.21

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.21

#### cyrus-core
- cyrus-core@0.2.21

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.21

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.21

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.21

#### cyrus-ai (CLI)
- cyrus-ai@0.2.21

## [0.2.20] - 2026-02-05

### Fixed
- **Agent guidance for draft PRs now respected** - When your Linear workspace guidance specifies `--draft` or requests PRs remain as drafts, Cyrus will no longer automatically convert them to ready for review. PRs also now correctly target the configured base branch instead of defaulting to main. ([CYPACK-784](https://linear.app/ceedar/issue/CYPACK-784), [#834](https://github.com/ceedaragents/cyrus/pull/834))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.20

#### cyrus-config-updater
- cyrus-config-updater@0.2.20

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.20

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.20

#### cyrus-core
- cyrus-core@0.2.20

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.20

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.20

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.20

#### cyrus-ai (CLI)
- cyrus-ai@0.2.20

## [0.2.19] - 2026-01-24

### Fixed
- Fixed configuration schema compatibility issue between cyrus-hosted and local installations. ([#802](https://github.com/ceedaragents/cyrus/pull/802))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.19

#### cyrus-config-updater
- cyrus-config-updater@0.2.19

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.19

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.19

#### cyrus-core
- cyrus-core@0.2.19

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.19

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.19

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.19

#### cyrus-ai (CLI)
- cyrus-ai@0.2.19

## [0.2.18] - 2026-01-23

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.18

#### cyrus-config-updater
- cyrus-config-updater@0.2.18

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.18

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.18

#### cyrus-core
- cyrus-core@0.2.18

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.18

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.18

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.18

#### cyrus-ai (CLI)
- cyrus-ai@0.2.18

## [0.2.17] - 2026-01-23

### Added
- **Issue update awareness** - Cyrus now detects when you edit an issue's title, description, or attachments while it's actively working on that issue. The agent receives context showing what changed (old vs new values) along with guidance to evaluate whether the update affects its implementation or action plan. TIP: instead of re-prompting Cyrus in a comment or chat window, just update the issue description with additional acceptance criteria! It will auto-start or adjust course and apply changes. ([CYPACK-736](https://linear.app/ceedar/issue/CYPACK-736), [#782](https://github.com/ceedaragents/cyrus/pull/782))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.17

#### cyrus-config-updater
- cyrus-config-updater@0.2.17

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.17

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.17

#### cyrus-core
- cyrus-core@0.2.17

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.17

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.17

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.17

#### cyrus-ai (CLI)
- cyrus-ai@0.2.17

## [0.2.16] - 2026-01-23

### Added
- **User access control** - Added the ability to whitelist or blacklist Linear users from delegating issues to Cyrus. Supports blocking specific users by Linear ID or email address, allowing only specific users (allowlist mode blocks everyone not explicitly listed), configurable block behavior (silent ignore or post comment), and template variables in block messages. Blocklist is additive (global + repo), while allowlist overrides (repo replaces global). Thanks to [@tjorri](https://github.com/tjorri) for the contribution! ([#779](https://github.com/ceedaragents/cyrus/pull/779))

### Improved
- **Better Cloudflare tunnel error messages** - When the Cloudflare tunnel fails to connect, Cyrus now provides detailed troubleshooting guidance including common causes (firewall, VPN, proxy issues) and links to connectivity prechecks documentation. This helps users quickly identify and resolve network configuration issues preventing tunnel establishment. ([CYPACK-743](https://linear.app/ceedar/issue/CYPACK-743), [#788](https://github.com/ceedaragents/cyrus/pull/788))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.16

#### cyrus-config-updater
- cyrus-config-updater@0.2.16

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.16

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.16

#### cyrus-core
- cyrus-core@0.2.16

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.16

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.16

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.16

#### cyrus-ai (CLI)
- cyrus-ai@0.2.16

## [0.2.15] - 2026-01-16

### Added
- **Version endpoint** - Added a `/version` endpoint that returns the Cyrus CLI version, enabling the dashboard to display version information. The endpoint returns `{ "cyrus_cli_version": "x.y.z" }` or `null` if unavailable. ([CYPACK-731](https://linear.app/ceedar/issue/CYPACK-731), [#775](https://github.com/ceedaragents/cyrus/pull/775))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.15

#### cyrus-config-updater
- cyrus-config-updater@0.2.15

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.15

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.15

#### cyrus-core
- cyrus-core@0.2.15

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.15

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.15

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.15

#### cyrus-ai (CLI)
- cyrus-ai@0.2.15

## [0.2.14] - 2026-01-16

### Fixed
- **Cross-repository orchestration** - Fixed an issue where parent sessions could not be resumed when orchestrating sub-issues across different repositories. Child sessions now correctly locate and resume their parent sessions regardless of which repository they belong to. ([CYPACK-722](https://linear.app/ceedar/issue/CYPACK-722), [#768](https://github.com/ceedaragents/cyrus/pull/768))
- **Summary subroutines no longer show extended "Working" status** - During summarization phases (concise-summary, verbose-summary, question-answer, plan-summary, user-testing-summary, release-summary), the agent no longer makes tool calls that caused users to see an extended "Working" status in Linear. The agent now produces only text output during these phases. ([CYPACK-723](https://linear.app/ceedar/issue/CYPACK-723), [#764](https://github.com/ceedaragents/cyrus/pull/764))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.14

#### cyrus-config-updater
- cyrus-config-updater@0.2.14

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.14

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.14

#### cyrus-core
- cyrus-core@0.2.14

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.14

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.14

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.14

#### cyrus-ai (CLI)
- cyrus-ai@0.2.14

## [0.2.13] - 2026-01-15

### Added
- **Multi-repository orchestration routing context** - Orchestrator prompts now receive routing context when multiple repositories are configured in the same workspace. This enables orchestrators to intelligently route sub-issues to different repositories using description tags (`[repo=org/repo-name]`), routing labels, team keys, or project keys. ([CYPACK-711](https://linear.app/ceedar/issue/CYPACK-711), [#756](https://github.com/ceedaragents/cyrus/pull/756))

### Fixed
- **Usage limit errors now display as errors** - When hitting usage limits (rate_limit) or other SDK errors, the agent now creates an "error" type activity instead of a "thought" type, making error messages more visible to users in the Linear UI. ([CYPACK-719](https://linear.app/ceedar/issue/CYPACK-719), [#760](https://github.com/ceedaragents/cyrus/pull/760))

### Changed
- **Orchestrator label routing is now hardcoded** - Issues with 'orchestrator' or 'Orchestrator' labels now always route to the orchestrator procedure, regardless of EdgeConfig settings. This ensures consistent orchestrator behavior without requiring explicit configuration. ([CYPACK-715](https://linear.app/ceedar/issue/CYPACK-715), [#757](https://github.com/ceedaragents/cyrus/pull/757))
- **Updated dependencies** - Updated `@anthropic-ai/claude-agent-sdk` from 0.2.2 to 0.2.7 ([changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md#027-2026-01-14)). This brings compatibility with Claude Code v2.1.7, which enables MCP tool search auto mode by default. When MCP tool descriptions exceed 10% of the context window, they are automatically deferred and discovered via the MCPSearch tool instead of being loaded upfront, reducing context usage for sessions with many MCP tools configured. ([CYPACK-716](https://linear.app/ceedar/issue/CYPACK-716), [#758](https://github.com/ceedaragents/cyrus/pull/758))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.13

#### cyrus-config-updater
- cyrus-config-updater@0.2.13

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.13

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.13

#### cyrus-core
- cyrus-core@0.2.13

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.13

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.13

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.13

#### cyrus-ai (CLI)
- cyrus-ai@0.2.13

## [0.2.12] - 2026-01-09

### Fixed
- **Case-insensitive label matching for orchestrator/debugger modes** - Label matching for orchestrator, debugger, builder, and scoper modes is now case-insensitive, matching the existing behavior of model selection. Labels like "Orchestrator" in Linear now correctly match config entries like `["orchestrator"]`. ([CYPACK-701](https://linear.app/ceedar/issue/CYPACK-701), [#746](https://github.com/ceedaragents/cyrus/pull/746))
- **Haiku model label support** - Fixed "haiku" as a supported model label for label-based model selection. Uses sonnet as fallback model for retry scenarios. ([CYPACK-701](https://linear.app/ceedar/issue/CYPACK-701), [#746](https://github.com/ceedaragents/cyrus/pull/746))

### Changed
- **Improved changelog handling** - Changelog updates now run as a separate subroutine before git operations, ensuring PR links can be included via amend. The `git-gh` subroutine has been split into `changelog-update`, `git-commit`, and `gh-pr` for better modularity. Non-changelog subroutines now explicitly avoid touching the changelog to prevent conflicts. ([CYPACK-670](https://linear.app/ceedar/issue/CYPACK-670), [#708](https://github.com/ceedaragents/cyrus/pull/708))
- **Updated dependencies** - Updated `@anthropic-ai/claude-agent-sdk` from 0.1.72 to 0.2.2 ([changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md#020-2026-01-07)). Updated `zod` from 3.x to 4.3.5 to satisfy peer dependencies. Migrated from `zod-to-json-schema` to Zod v4's native `toJSONSchema()` method. ([CYPACK-700](https://linear.app/ceedar/issue/CYPACK-700), [#745](https://github.com/ceedaragents/cyrus/pull/745))

### Added
- **Worktree include support** - Add `.worktreeinclude` file support to automatically copy gitignored files (like `.env`, local configs) from the main repository to new worktrees. Files must be listed in both `.worktreeinclude` AND `.gitignore` to be copied. Supports glob patterns like `.env.*` and `**/.claude/settings.local.json`. ([CYPACK-690](https://linear.app/ceedar/issue/CYPACK-690), [#734](https://github.com/ceedaragents/cyrus/pull/734))
- **Screenshot upload guidance hooks** - Agents are now guided to use `linear_upload_file` when taking screenshots, ensuring screenshots are viewable in Linear comments instead of remaining as local files. Hooks added for `playwright_screenshot`, `mcp__claude-in-chrome__computer`, `mcp__claude-in-chrome__gif_creator`, and `mcp__chrome-devtools__take_screenshot`. ([CYPACK-699](https://linear.app/ceedar/issue/CYPACK-699), [#744](https://github.com/ceedaragents/cyrus/pull/744))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.12

#### cyrus-config-updater
- cyrus-config-updater@0.2.12

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.12

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.12

#### cyrus-core
- cyrus-core@0.2.12

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.12

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.12

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.12

#### cyrus-ai (CLI)
- cyrus-ai@0.2.12

## [0.2.11] - 2026-01-07

### Fixed
- **Repository tag routing now works with Linear's escaped brackets** - Fixed a bug where `[repo=...]` tags weren't recognized because Linear escapes square brackets in descriptions (e.g., `\[repo=cyrus\]`). The parser now handles both escaped and unescaped formats. ([CYPACK-688](https://linear.app/ceedar/issue/CYPACK-688), [#738](https://github.com/ceedaragents/cyrus/pull/738))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.11

#### cyrus-config-updater
- cyrus-config-updater@0.2.11

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.11

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.11

#### cyrus-core
- cyrus-core@0.2.11

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.11

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.11

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.11

#### cyrus-ai (CLI)
- cyrus-ai@0.2.11

## [0.2.10] - 2026-01-06

### Added
- **Repository tag routing** - You can now specify which repository an issue should be routed to by adding a `[repo=...]` tag in the issue description. Supports `[repo=org/repo-name]` to match GitHub URLs, `[repo=repo-name]` to match by name, or `[repo=repo-id]` to match by ID. This takes precedence over label, project, and team-based routing. ([CYPACK-688](https://linear.app/ceedar/issue/CYPACK-688), [#732](https://github.com/ceedaragents/cyrus/pull/732))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.10

#### cyrus-config-updater
- cyrus-config-updater@0.2.10

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.10

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.10

#### cyrus-core
- cyrus-core@0.2.10

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.10

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.10

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.10

#### cyrus-ai (CLI)
- cyrus-ai@0.2.10

## [0.2.9] - 2025-12-30

### Added
- **Repository tag routing** - You can now specify which repository an issue should be routed to by adding a `[repo=...]` tag in the issue description. Supports `[repo=org/repo-name]` to match GitHub URLs, `[repo=repo-name]` to match by name, or `[repo=repo-id]` to match by ID. This takes precedence over label, project, and team-based routing. ([CYPACK-688](https://linear.app/ceedar/issue/CYPACK-688), [#732](https://github.com/ceedaragents/cyrus/pull/732))
- **GPT Image 1.5 support** - The image-tools MCP server now supports `gpt-image-1.5`, OpenAI's latest and highest quality image generation model. You can choose between `gpt-image-1.5` (default, best quality), `gpt-image-1`, or `gpt-image-1-mini` (faster, lower cost). ([CYPACK-675](https://linear.app/ceedar/issue/CYPACK-675), [#717](https://github.com/ceedaragents/cyrus/pull/717))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.9

#### cyrus-config-updater
- cyrus-config-updater@0.2.9

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.9

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.9

#### cyrus-core
- cyrus-core@0.2.9

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.9

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.9

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.9

#### cyrus-ai (CLI)
- cyrus-ai@0.2.9

## [0.2.8] - 2025-12-28

### Added
- **Release procedure** - Added a new `release` procedure with two subroutines for executing software releases. When an issue is classified as a release request, Cyrus will: (1) check for a release skill in the project, (2) check CLAUDE.md or README.md for release instructions, or (3) ask the user via AskUserQuestion how to perform the release. This enables Cyrus to handle release workflows for any project type. ([CYPACK-668](https://linear.app/ceedar/issue/CYPACK-668), [#706](https://github.com/ceedaragents/cyrus/pull/706))
- **Self-hosting OAuth commands** - New CLI commands for self-hosted deployments: `cyrus self-auth` performs direct Linear OAuth authorization without a proxy, and `cyrus self-add-repo` clones repositories and adds them to config with inherited workspace credentials. Both commands support the `--cyrus-home` flag for custom configuration directories. See the [Self-Hosting Guide](./docs/SELF_HOSTING.md) for setup instructions. Based on the [original OAuth implementation](https://github.com/grandmore/cyrus-self-hosting/pull/1) contributed by Stuart and the Grandmore team. ([CYPACK-669](https://linear.app/ceedar/issue/CYPACK-669), [#707](https://github.com/ceedaragents/cyrus/pull/707))

### Changed
- **Documentation restructured** - Moved self-hosting documentation from `selfhosting/` folder to `docs/` with separate files: `SELF_HOSTING.md` (main guide), `CONFIG_FILE.md` (configuration reference), and `CLOUDFLARE_TUNNEL.md` (optional tunnel setup). Main README now links to these docs. ([CYPACK-669](https://linear.app/ceedar/issue/CYPACK-669), [#707](https://github.com/ceedaragents/cyrus/pull/707))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.8

#### cyrus-config-updater
- cyrus-config-updater@0.2.8

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.8

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.8

#### cyrus-core
- cyrus-core@0.2.8

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.8

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.8

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.8

#### cyrus-ai (CLI)
- cyrus-ai@0.2.8

## [0.2.7] - 2025-12-28

### Fixed
- **AskUserQuestion UI cleanup** - The AskUserQuestion tool no longer appears as raw JSON in Linear's activity stream. Since the tool is custom-handled via Linear's select signal elicitation, the tool call and result are now suppressed from the activity UI for a cleaner experience. ([CYPACK-654](https://linear.app/ceedar/issue/CYPACK-654), [#698](https://github.com/ceedaragents/cyrus/pull/698))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.7

#### cyrus-config-updater
- cyrus-config-updater@0.2.7

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.7

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.7

#### cyrus-core
- cyrus-core@0.2.7

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.7

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.7

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.7

#### cyrus-ai (CLI)
- cyrus-ai@0.2.7

## [0.2.6] - 2025-12-22

### Changed
- **Default model upgraded to Opus** - Cyrus now uses Claude Opus as the default model with Sonnet as fallback (previously Sonnet with Haiku fallback). This provides higher quality responses for all tasks. ([CYPACK-613](https://linear.app/ceedar/issue/CYPACK-613))
- Updated `@anthropic-ai/claude-agent-sdk` from v0.1.69 to v0.1.72 to maintain parity with Claude Code v2.0.72. This update includes fixed `/context` command behavior to respect custom system prompts, improved non-streaming performance for single-turn queries, and renamed V2 session API method from `receive()` to `stream()`. See the [Claude Agent SDK changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md#0172) for full details. ([CYPACK-618](https://linear.app/ceedar/issue/CYPACK-618))

### Added
- **Interactive clarification via AskUserQuestion** - Cyrus can now ask you clarifying questions during task execution using Linear's select signal. When Claude needs to make a decision with multiple valid options (e.g., which sorting algorithm, which library to use), it will present the options in Linear and wait for your selection before proceeding. This enables more interactive and accurate task completion. ([CYPACK-654](https://linear.app/ceedar/issue/CYPACK-654), [#691](https://github.com/ceedaragents/cyrus/pull/691))
- **Custom Skills support** - Cyrus now supports Claude Skills, allowing you to extend Cyrus with your own packaged capabilities. Create `SKILL.md` files in your project's `.claude/skills/` directory or personal `~/.claude/skills/` directory, and Cyrus will automatically discover and use them when relevant. See the [Skills documentation](https://code.claude.com/docs/en/skills) for details on creating Skills. ([CYPACK-655](https://linear.app/ceedar/issue/CYPACK-655), [#690](https://github.com/ceedaragents/cyrus/pull/690))
- **Acceptance criteria validation** - The verifications subroutine now fetches the Linear issue and validates the implementation against all acceptance criteria. Failing to meet acceptance criteria counts as a failed verification, ensuring requirements are fully satisfied before proceeding to commit and PR creation. ([CYPACK-649](https://linear.app/ceedar/issue/CYPACK-649), [#687](https://github.com/ceedaragents/cyrus/pull/687))
- **Validation loop with retry logic** - When verifications fail during the full-development procedure, Cyrus now automatically runs a fixer subroutine to address issues, then re-runs verification up to 4 times. Uses structured outputs with Zod schema validation for reliable pass/fail detection, with fallback parsing for Gemini compatibility. ([CYPACK-620](https://linear.app/ceedar/issue/CYPACK-620), [#666](https://github.com/ceedaragents/cyrus/pull/666))
- **Claude in Chrome integration** - EdgeWorker now enables Chrome browser automation via the Claude Agent SDK's `--chrome` flag, providing access to browser automation tools (screenshot recording, console reading, JavaScript execution, tab management) for main Cyrus sessions. Simple agent runners explicitly disable this integration to keep lightweight queries fast. ([CYPACK-618](https://linear.app/ceedar/issue/CYPACK-618))
- **Process status endpoint** - Added `GET /status` endpoint that returns `{"status": "idle"}` or `{"status": "busy"}` to safely determine when Cyrus can be restarted without interrupting active work. ([CYPACK-576](https://linear.app/ceedar/issue/CYPACK-576), [#632](https://github.com/ceedaragents/cyrus/pull/632))
- **Version logging on startup** - Cyrus now displays the running version when the edge worker starts, making it easier to verify which version is deployed. ([CYPACK-585](https://linear.app/ceedar/issue/CYPACK-585))
- Added CLI platform mode support to enable in-memory issue tracking for testing and development ([CYPACK-509](https://linear.app/ceedar/issue/CYPACK-509))
- **User testing procedure** - New "user-testing" procedure for interactive, user-driven testing sessions. When you explicitly request manual testing (e.g., "test this for me", "run user testing"), Cyrus will execute tests based on your instructions and provide a comprehensive summary of results and findings. ([CYPACK-542](https://linear.app/ceedar/issue/CYPACK-542))
- **Graphite workflow support** - Cyrus now integrates with Graphite CLI for stacked PR workflows. Apply a "graphite" label to any issue to enable Graphite-aware behavior: sub-issues automatically branch from their blocking issue's branch (based on Linear's "blocked by" relationships) instead of main, and PRs are created using `gt submit`. For orchestrating complex multi-part features, apply both "graphite" and "orchestrator" labels - the orchestrator will create dependent sub-issues with proper blocking relationships that automatically stack in Graphite's dashboard. ([CYPACK-466](https://linear.app/ceedar/issue/CYPACK-466), [#577](https://github.com/ceedaragents/cyrus/pull/577))
- **Linear agent sessions MCP tools** - Added `linear_get_agent_sessions` and `linear_get_agent_session` tools to cyrus-tools MCP server for retrieving agent session information from Linear. The tools support pagination, filtering, and provide comprehensive session details including timestamps, associated issues, and related entities. ([CYPACK-549](https://linear.app/ceedar/issue/CYPACK-549), [#625](https://github.com/ceedaragents/cyrus/pull/625))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.6

#### cyrus-config-updater
- cyrus-config-updater@0.2.6

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.6

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.6

#### cyrus-core
- cyrus-core@0.2.6

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.6

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.6

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.6

#### cyrus-ai (CLI)
- cyrus-ai@0.2.6

## [0.2.5] - 2025-12-03

### Fixed
- Fixed Zod peer dependency mismatch in claude-runner that caused `mcp__cyrus-tools__linear_agent_session_create` MCP tools to fail with `keyValidator._parse is not a function` error. Downgraded claude-runner's Zod dependency from v4.1.12 to v3.24.1 to match the Claude Agent SDK's peer dependency requirement ([CYPACK-478](https://linear.app/ceedar/issue/CYPACK-478), [#581](https://github.com/ceedaragents/cyrus/pull/581))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.5

#### cyrus-config-updater
- cyrus-config-updater@0.2.5

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.5

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.5

#### cyrus-core
- cyrus-core@0.2.5

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.5

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.5

#### cyrus-ai (CLI)
- cyrus-ai@0.2.5

## [0.2.4] - 2025-11-25

### Added
- **Google Gemini AI support** - Cyrus now supports Google's Gemini models alongside Claude. Choose which AI processes your issues by adding labels to Linear issues: use `gemini`, `gemini-2.5-pro`, `gemini-2.5-flash`, or `gemini-3-pro` for Gemini models, or `claude`, `sonnet`, or `opus` for Claude models. If no AI label is present, Cyrus defaults to Claude. This gives you flexibility to select the best AI for each task.

### Fixed
- Fixed race condition in subroutine transitions where new subroutines could start before the previous runner fully cleaned up, which could cause issues with session state management

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.4

#### cyrus-config-updater
- cyrus-config-updater@0.2.4

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.4

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.4

#### cyrus-core
- cyrus-core@0.2.4

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.4

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.4

#### cyrus-ai (CLI)
- cyrus-ai@0.2.4

## [0.2.3] - 2025-11-24

### Added
- **Claude Opus 4.5 support** - Cyrus now has access to [Claude Opus 4.5](https://www.anthropic.com/claude/opus), Anthropic's most intelligent model with breakthrough capabilities in complex reasoning, advanced coding, and nuanced content creation. Experience significantly improved code generation, deeper analysis, and more sophisticated problem-solving across all Cyrus workflows.

### Changed
- Updated @anthropic-ai/claude-agent-sdk from v0.1.42 to v0.1.52 - includes support for Claude Opus 4.5 and latest agent capabilities. See [@anthropic-ai/claude-agent-sdk v0.1.52 changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md#0152) ([CYPACK-427](https://linear.app/ceedar/issue/CYPACK-427), [#558](https://github.com/ceedaragents/cyrus/pull/558))
- Updated @anthropic-ai/sdk from v0.69.0 to v0.71.0 - adds Claude Opus 4.5 model support with enhanced performance and capabilities. See [@anthropic-ai/sdk v0.71.0 changelog](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/CHANGELOG.md#0710-2025-11-22) ([CYPACK-427](https://linear.app/ceedar/issue/CYPACK-427), [#558](https://github.com/ceedaragents/cyrus/pull/558))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.3

#### cyrus-config-updater
- cyrus-config-updater@0.2.3

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.3

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.3

#### cyrus-core
- cyrus-core@0.2.3

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.3

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.3

#### cyrus-ai (CLI)
- cyrus-ai@0.2.3

## [0.2.2] - 2025-11-19

### Changed
- Improved Linear agent-session tool formatting with custom formatters for better readability: Bash tool descriptions now appear in the action field with round brackets, Edit tool results display as unified diffs, and specialized parameter/result formatters for common tools (Read, Write, Grep, Glob, etc.) extract meaningful information instead of showing raw JSON (CYPACK-395, https://github.com/ceedaragents/cyrus/pull/512)

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.2

#### cyrus-config-updater
- cyrus-config-updater@0.2.2

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.2

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.2

#### cyrus-core
- cyrus-core@0.2.2

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.2

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.2

#### cyrus-ai (CLI)
- cyrus-ai@0.2.2

## [0.2.1] - 2025-11-15

### Added
- When no routing option matches, it will prompt the user to select which repo they'd like to run Cyrus on for the Linear Issue. Repository selection now displays GitHub repository icons and formatted names when configured with a GitHub URL in the config file. The selected repository will be shown to the user, including what method was used to select it (label-based, team key based, project based, user-selected, etc)
- Restored `--env-file` option to specify custom environment variables file location (uses Commander library for CLI parsing)

### Changed
- Updated @anthropic-ai/claude-agent-sdk from v0.1.31 to v0.1.42 - see [@anthropic-ai/claude-agent-sdk v0.1.42 changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md#0142)
- Updated @anthropic-ai/sdk from v0.68.0 to v0.69.0 - adds support for structured outputs beta - see [@anthropic-ai/sdk v0.69.0 changelog](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/CHANGELOG.md#0690-2025-11-14)

### Fixed
- Fixed Linear profile URLs in summary subroutines to use correct workspace slug instead of hardcoded "linear" workspace

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.1

#### cyrus-config-updater
- cyrus-config-updater@0.2.1

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.1

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.1

#### cyrus-core
- cyrus-core@0.2.1

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.1

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.1

#### cyrus-ai (CLI)
- cyrus-ai@0.2.1

## [0.2.0] - 2025-11-07

### Added
- **Cloudflare Tunnel Transport Client**: New `cyrus-cloudflare-tunnel-client` package for receiving configuration updates and webhooks from cyrus-hosted
  - Uses Cloudflare tunnels via `cloudflared` npm package for secure communication
  - Validates customer subscriptions with cyrus-hosted API
  - Handles configuration updates (repositories, environment variables, MCP servers)
  - Receives Linear webhook payloads forwarded through cyrus-hosted
  - Repository management (automatically clones/verifies repositories to `~/.cyrus/repos/<repo-name>`)
  - All file operations restricted to `~/.cyrus` directory for security
  - Will replace `ndjson-client` for customers using cyrus-hosted service
- **Setup Waiting Mode**: After running `cyrus auth`, the client now enters a waiting state to receive configuration from the server
  - Automatically starts server infrastructure (SharedApplicationServer, ConfigUpdater) without repositories
  - Displays clear waiting status and instructions to complete setup
  - Auto-transitions to normal operation when server pushes repository configuration
  - Watches config.json for changes and starts EdgeWorker when repositories are added

### Fixed
- Cyrus client now stays running when all repositories are removed after onboarding, allowing it to receive new configuration from app.atcyrus.com
- Orchestrator label now enforces orchestrator procedure consistently - issues with the Orchestrator label always use the orchestrator-full procedure, even when receiving results from child sub-agents or processing new messages
- Suppressed unnecessary error logs when stopping Claude sessions
- Repository deletion now works correctly when triggered from the web UI
- Added missing `routingLabels` and `projectKeys` fields to `CyrusConfigPayload` type in config-updater package
- Config handler now properly processes and saves label routing and project routing parameters when received from cyrus-hosted
- Fixed missing `dist/` directory in published packages by adding `"files": ["dist"]` to `cloudflare-tunnel-client` and `config-updater` package.json files
- All packages now include their compiled TypeScript output when installed from npm

### Changed
- **Linear Event Transport**: Refactored `cyrus-linear-webhook-client` to `cyrus-linear-event-transport` for simplified webhook handling
  - Package now directly registers /webhook endpoint with Fastify server
  - Supports dual verification modes: direct Linear webhooks (LINEAR_DIRECT_WEBHOOKS) and proxy authentication
  - Removed complex transport abstractions (WebhookTransport, BaseTransport) in favor of direct route registration
  - Routes registered after server startup for improved initialization flow
- **Simplified CLI startup**: Removed legacy onboarding flows and subscription validation
  - Cloudflare tunnel now starts automatically when CLOUDFLARE_TOKEN is present
  - Removed Pro plan prompts and customer validation code
  - Removed `billing` and `set-customer-id` commands
  - Streamlined `auth` command to focus on authentication only
  - All tunnel management now handled by SharedApplicationServer
- Updated @anthropic-ai/claude-agent-sdk from v0.1.28 to v0.1.31 - see [@anthropic-ai/claude-agent-sdk v0.1.31 changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md#0131)
- Updated @anthropic-ai/sdk from v0.67.0 to v0.68.0 - see [@anthropic-ai/sdk v0.68.0 changelog](https://github.com/anthropics/anthropic-sdk-typescript/compare/sdk-v0.67.0...sdk-v0.68.0)

### Removed
- **Subscription service**: Removed customer validation and subscription checking code
- **Billing commands**: Removed `billing` and `set-customer-id` CLI commands
- **Deprecated config parameter**: Removed `isLegacy` from EdgeConfig (replaced by setup waiting mode)

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.0

#### cyrus-config-updater
- cyrus-config-updater@0.2.0

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.0

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.0

#### cyrus-core
- cyrus-core@0.2.0

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.0

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.0

#### cyrus-ai (CLI)
- cyrus-ai@0.2.0

## [0.1.60] - 2025-11-03

### Fixed
- Orchestrator label now enforces orchestrator procedure consistently - issues with the Orchestrator label always use the orchestrator-full procedure, even when receiving results from child sub-agents or processing new messages
- Suppressed unnecessary error logs when stopping Claude sessions

### Changed
- Updated @anthropic-ai/claude-agent-sdk from v0.1.28 to v0.1.31
- Updated @anthropic-ai/sdk from v0.67.0 to v0.68.0 - see [@anthropic-ai/sdk v0.68.0 changelog](https://github.com/anthropics/anthropic-sdk-typescript/compare/sdk-v0.67.0...sdk-v0.68.0)

### Packages

#### cyrus-core
- cyrus-core@0.0.21

#### cyrus-claude-runner
- cyrus-claude-runner@0.0.32

#### cyrus-edge-worker
- cyrus-edge-worker@0.0.41

#### cyrus-ndjson-client
- cyrus-ndjson-client@0.0.25

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.0.4

#### cyrus-ai (CLI)
- cyrus-ai@0.1.60

## [0.1.59] - 2025-10-31

### Fixed
- Skip loading 'primary' subroutine prompt to eliminate ENOENT error in logs - the "primary" promptPath is a placeholder with no corresponding file

### Packages

#### cyrus-core
- cyrus-core@0.0.20

#### cyrus-edge-worker
- cyrus-edge-worker@0.0.40

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.0.3

#### cyrus-ai (CLI)
- cyrus-ai@0.1.59

## [0.1.58] - 2025-10-29

### Added
- Orchestrator and sub-issue communication is now visible in Linear activity: feedback from orchestrator to sub-issues and results from sub-issues to orchestrator are posted as thoughts with clear context

### Fixed
- Procedure routing is now reset when resuming parent sessions from child completion, preventing excessive thought and action suppression logs
- Fixed bug where initial subroutine prompts were not applied to comment-triggered new sessions (only worked for assignment-based sessions)
- Improved routing classification to correctly identify test-related requests (e.g., "add unit tests", "fix failing tests") as code work instead of planning tasks

### Changed
- Debugger workflow now proceeds directly from bug reproduction to fix implementation without requiring manual approval
- All workflows (full-development, debugger-full, orchestrator-full) now end with concise summary instead of verbose summary
- Non-summary subroutines (debugger-fix, debugger-reproduction, verifications, git-gh) now explicitly avoid posting Linear comments and end with brief 1-sentence completion messages
- Orchestrator agents are now strongly discouraged from posting Linear comments to current issues; comments only used when triggering sub-agent sessions on child issues
- Orchestrator agents are explicitly instructed not to assign themselves (Cyrus) as a delegate when creating sub-issues
- Tool call result outputs are no longer wrapped in collapsible sections in Linear comments
- Concise summary format now uses collapsible sections for "Changes Made" and "Files Modified" to keep summaries brief
- Simple-question workflow now has two phases: investigation (gather information without answering) and answer formatting (provide markdown-formatted response)
- Initial subroutine prompts are now consistently loaded for all new sessions (assignment-based and comment-based), ensuring agents receive proper workflow guidance from the start
- Full-development workflow now starts with dedicated coding-activity subroutine (implementation and testing only, no git/gh operations)

### Packages

#### cyrus-core
- cyrus-core@0.0.20

#### cyrus-edge-worker
- cyrus-edge-worker@0.0.40

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.0.3

#### cyrus-ai (CLI)
- cyrus-ai@0.1.58

## [0.1.57] - 2025-10-12

### Fixed
- Fixed missing `cyrus-simple-agent-runner` package publication that broke installation of cyrus-ai@0.1.56

### Packages

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.0.2

#### cyrus-edge-worker
- cyrus-edge-worker@0.0.39

#### cyrus-ai (CLI)
- cyrus-ai@0.1.57

## [0.1.56] - 2025-10-12

### Added
- **Intelligent procedure routing**: Cyrus now automatically selects the best workflow for each task by analyzing the request content. Simple questions get quick answers, documentation edits proceed directly to implementation, and code changes get the full workflow with verifications and git operations. Uses fast "haiku" model for 10-second classification.
- **Modular subroutine system**: Workflows are composed of reusable subroutines (verifications, git-gh, concise-summary, verbose-summary) that can be mixed and matched based on the procedure selected.
- **Environment variable support in MCP configs**: MCP configuration files can now reference environment variables from repository `.env` files using `${VAR}` and `${VAR:-default}` syntax, making it easier to manage API tokens and other sensitive configuration values
- **Sora 2 video generation support**: Added custom MCP tools for OpenAI Sora 2 video generation with three tools: `mcp__sora-tools__sora_generate_video` to start video generation (supports text-to-video and image-to-video via `input_reference` parameter; reference images must match target video resolution and be in JPEG, PNG, or WebP format only), `mcp__sora-tools__sora_check_status` to poll job status, and `mcp__sora-tools__sora_get_video` to download completed videos
- **Simple agent runner package**: Added new `cyrus-simple-agent-runner` package for constrained agent queries that return one of a predefined set of responses (e.g., "yes", "no"). Features type-safe enumerated responses, comprehensive error handling, and progress tracking.
- **Image generation support**: Added GPT Image tools using OpenAI's Responses API with background mode. Two tools provide async image generation: `mcp__image-tools__gpt_image_generate` starts async image generation and returns a job ID, and `mcp__image-tools__gpt_image_get` checks status and downloads the image if ready (returns "not ready" if incomplete - agents can call again). Supports customizable size (1024x1024, 1536x1024, 1024x1536, auto), quality (low/medium/high/auto), background transparency, and output formats (PNG/JPEG/WebP). Uses gpt-5 model for tool invocation.

### Changed
- Updated @anthropic-ai/claude-agent-sdk from v0.1.13 to v0.1.14 - includes parity updates with Claude Code v2.0.14. See [@anthropic-ai/claude-agent-sdk v0.1.14 changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md#0114)
- **Breaking: OpenAI configuration naming**: Renamed repository config fields from `soraApiKey`/`soraOutputDirectory` to `openaiApiKey`/`openaiOutputDirectory` to reflect support for multiple OpenAI services (Sora and GPT Image). Update your repository config to use the new field names.

### Packages

#### cyrus-claude-runner
- cyrus-claude-runner@0.0.31

#### cyrus-core
- cyrus-core@0.0.19

#### cyrus-edge-worker
- cyrus-edge-worker@0.0.38

#### cyrus-ndjson-client
- cyrus-ndjson-client@0.0.24

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.0.2

#### cyrus-ai (CLI)
- cyrus-ai@0.1.56

## [0.1.55] - 2025-10-09

### Added
- **Dynamic configuration updates**: Cyrus now automatically detects and applies changes to `~/.cyrus/config.json` without requiring a restart
  - Add or remove repositories on the fly while Cyrus continues running
  - Removed repositories stop all active sessions and post notification messages to Linear
  - Webhook connections automatically reconnect when tokens are updated
  - File watcher uses debouncing to handle rapid configuration changes smoothly

### Changed
- **Upgraded to official Linear MCP server**: Replaced the unofficial `@tacticlaunch/mcp-linear` stdio-based server with Linear's official HTTP-based MCP server (`https://mcp.linear.app/mcp`). This provides better stability and access to the latest Linear API features.
- Updated @anthropic-ai/claude-agent-sdk from v0.1.10 to v0.1.11 - includes parity updates with Claude Code v2.0.11. See [@anthropic-ai/claude-agent-sdk v0.1.11 changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md#0111---2025-01-09)

### Packages

#### cyrus-claude-runner
- cyrus-claude-runner@0.0.30

#### cyrus-core
- cyrus-core@0.0.18

#### cyrus-edge-worker
- cyrus-edge-worker@0.0.37

#### cyrus-ndjson-client
- cyrus-ndjson-client@0.0.23

#### cyrus-ai (CLI)
- cyrus-ai@0.1.55

## [0.1.54] - 2025-10-04

### Added
- **Automatic MCP config detection**: Cyrus now automatically detects and loads `.mcp.json` files in the repository root. The `.mcp.json` serves as a base configuration that can be extended by explicit `mcpConfigPath` settings, allowing for composable MCP server configurations.

### Fixed
- **Custom instructions now work correctly**: Fixed critical bug where `appendSystemPrompt` was being silently ignored, causing Cyrus to not follow custom instructions or agent guidance. The feature has been fixed to use the correct SDK API (`systemPrompt.append`), making custom prompts and Linear agent guidance work as intended.

### Packages

#### cyrus-claude-runner
- cyrus-claude-runner@0.0.29

#### cyrus-core
- cyrus-core@0.0.17

#### cyrus-edge-worker
- cyrus-edge-worker@0.0.36

#### cyrus-ndjson-client
- cyrus-ndjson-client@0.0.22

#### cyrus-ai (CLI)
- cyrus-ai@0.1.54

## [0.1.53] - 2025-10-04

### Added
- **Agent guidance injection**: Cyrus now automatically receives and includes both workspace-level and team-specific agent guidance from Linear in all prompts. When both types of guidance are configured, both are included in the prompt, with team-specific guidance taking precedence as specified by Linear's guidance system.

### Changed
- Updated @linear/sdk from v58.1.0 to v60.0.0 to support agent guidance feature

### Packages

#### cyrus-claude-runner
- cyrus-claude-runner@0.0.28

#### cyrus-core
- cyrus-core@0.0.16

#### cyrus-edge-worker
- cyrus-edge-worker@0.0.35

#### cyrus-ndjson-client
- cyrus-ndjson-client@0.0.21

#### cyrus-ai (CLI)
- cyrus-ai@0.1.53

## [0.1.52] - 2025-10-04

### Changed
- Version bump for all packages to ensure proper dependency resolution

### Packages

#### cyrus-claude-runner
- cyrus-claude-runner@0.0.27

#### cyrus-core
- cyrus-core@0.0.15

#### cyrus-edge-worker
- cyrus-edge-worker@0.0.34

#### cyrus-ndjson-client
- cyrus-ndjson-client@0.0.20

#### cyrus-ai (CLI)
- cyrus-ai@0.1.52

## [0.1.51] - 2025-10-04

### Fixed
- **Restored file-based settings loading**: Fixed regression from claude-agent-sdk update where CLAUDE.md files, settings files, and custom slash commands were not being loaded
  - Added explicit `settingSources: ["user", "project", "local"]` configuration to ClaudeRunner
  - This restores backwards compatibility with existing user configurations
  - See [Claude Code SDK Migration Guide](https://docs.claude.com/en/docs/claude-code/sdk/migration-guide#settings-sources-no-longer-loaded-by-default)

### Changed
- **Default model changed from opus to sonnet 4.5**: The default Claude model is now `sonnet` instead of `opus`
  - Fallback model changed from `sonnet` to `haiku`
  - Label-based model selection still available - users can add `opus`, `sonnet`, or `haiku` labels to issues to override the default
  - Affects all new sessions that don't explicitly specify a model in config
- Updated @anthropic-ai/claude-agent-sdk from v0.1.0 to v0.1.5 for latest Claude Agent SDK improvements
- Updated @anthropic-ai/sdk from v0.64.0 to v0.65.0 for latest Anthropic SDK improvements
  - Added support for Claude Sonnet 4.5 and context management features
  - See [@anthropic-ai/sdk v0.65.0 changelog](https://github.com/anthropics/anthropic-sdk-typescript/compare/sdk-v0.64.0...sdk-v0.65.0)

### Packages

#### cyrus-claude-runner
- cyrus-claude-runner@0.0.26

#### cyrus-core
- cyrus-core@0.0.14

#### cyrus-edge-worker
- cyrus-edge-worker@0.0.33

#### cyrus-ndjson-client
- cyrus-ndjson-client@0.0.19

#### cyrus-ai (CLI)
- cyrus-ai@0.1.51

## [0.1.50] - 2025-09-30

### Added
- **Global setup script support**: Added `global_setup_script` optional field in config.json
  - Runs before repository-specific `cyrus-setup.sh` when creating git worktrees
  - Supports ~ expansion for home directory paths
  - Same environment variables passed to both global and repository scripts (LINEAR_ISSUE_ID, LINEAR_ISSUE_IDENTIFIER, LINEAR_ISSUE_TITLE)
  - 5-minute timeout to prevent hanging scripts
  - Comprehensive error handling and logging for both global and repository scripts
  - Script failures don't prevent worktree creation
  - Cross-platform support (bash, PowerShell, cmd, bat)

- **Ephemeral agent activities for tool calls**: Standard tool calls now post ephemeral activities to Linear
  - Tool calls (except Task and TodoWrite) create ephemeral activities that disappear when replaced
  - Tool responses create non-ephemeral activities showing original tool name and input
  - Tool outputs are wrapped in `+++Tool Output` collapsible blocks (collapsed by default)
  - Tool errors display as "{ToolName} (Error)" for better clarity
  - Subtasks maintain arrow emoji (↪) prefix for visual hierarchy
  - TodoWrite tool results are skipped to prevent duplicate activities
  - Reduces visual clutter in Linear while preserving important information

### Changed
- **Linear SDK upgraded to v58.1.0**: Updated across all packages to support ephemeral agent activity field
  - Added `ephemeral: boolean` support for agent activities
  - Maintained backward compatibility with existing non-ephemeral activities

### Packages

#### cyrus-claude-runner
- cyrus-claude-runner@0.0.26

#### cyrus-core
- cyrus-core@0.0.14

#### cyrus-edge-worker
- cyrus-edge-worker@0.0.33

#### cyrus-linear-webhook-client
- cyrus-linear-webhook-client@0.0.3

#### cyrus-ndjson-client
- cyrus-ndjson-client@0.0.19

## [0.1.49] - 2025-09-29

### Changed
- **Migrated from Claude Code SDK to Claude Agent SDK**: Replaced `@anthropic-ai/claude-code` v1.0.128 with `@anthropic-ai/claude-agent-sdk` v0.1.0
  - Updated all imports and type references to use the new package name
  - Handled breaking change: SDK no longer uses Claude Code's system prompt by default - now explicitly requests Claude Code preset to maintain backward compatibility
  - No changes needed for settings sources as the codebase doesn't rely on automatic settings file loading
- Updated @anthropic-ai/sdk from v0.62.0 to v0.64.0 for latest Anthropic SDK improvements

### Packages

#### cyrus-claude-runner
- cyrus-claude-runner@0.0.25

#### cyrus-core
- cyrus-core@0.0.13

#### cyrus-edge-worker
- cyrus-edge-worker@0.0.32

#### cyrus-ai (CLI)
- cyrus-ai@0.1.49

## [0.1.48] - 2025-01-11

### Added
- **Direct OAuth authorization support**: The CLI can now handle OAuth authorization directly when `LINEAR_DIRECT_WEBHOOKS=true`
  - New `/oauth/authorize` endpoint in SharedApplicationServer for self-hosted OAuth flow
  - Automatic OAuth code exchange when using direct webhooks mode
  - Support for custom Linear OAuth applications via `LINEAR_CLIENT_ID` and `LINEAR_CLIENT_SECRET` environment variables
  - Maintains backward compatibility with proxy-based OAuth for standard deployments

### Packages

#### cyrus-edge-worker
- cyrus-edge-worker@0.0.31

#### cyrus-ai (CLI)
- cyrus-ai@0.1.48

## [0.1.47] - 2025-01-09

### Fixed
- Fixed webhook signature verification for LinearWebhookClient
  - Corrected signature verification to properly handle webhook payloads
  - Ensures webhook authenticity when using direct webhook forwarding mode
  - Resolves security validation issues in direct webhook configurations

### Packages

#### cyrus-linear-webhook-client
- cyrus-linear-webhook-client@0.0.2

#### cyrus-edge-worker
- cyrus-edge-worker@0.0.30

#### cyrus-ai (CLI)
- cyrus-ai@0.1.47

## [0.1.46] - 2025-01-09

### Added
- **Dynamic webhook client selection**: Support for choosing between proxy-based and direct webhook forwarding
  - New environment variable `LINEAR_DIRECT_WEBHOOKS` to control webhook client selection
  - When `LINEAR_DIRECT_WEBHOOKS=true`, uses new `linear-webhook-client` package for direct webhook forwarding
  - When unset or `false`, uses existing `ndjson-client` for proxy-based webhook handling
  - Maintains full backward compatibility with existing deployments
- **Sub-issue assignee inheritance with workspace context**: Sub-issues created by orchestrator agents now automatically inherit the same assignee as their parent issue, with complete workspace awareness
  - Enhanced label-prompt-template to include assignee information (`{{assignee_id}}` and `{{assignee_name}}`)
  - Added workspace teams context (`{{workspace_teams}}`) with team names, keys, IDs, and descriptions
  - Added workspace labels context (`{{workspace_labels}}`) with label names, IDs, and descriptions  
  - Updated orchestrator prompt instructions to require `assigneeId` parameter in sub-issue creation
  - Modified EdgeWorker to fetch and inject Linear workspace data (teams, labels, assignee) into orchestrator context
- **Mandatory verification framework for orchestrator agents**: Enhanced parent-child delegation with executable verification requirements
  - Parent orchestrators can now access child agent worktrees for independent verification
  - **Orchestrator prompt v2.2.0** with mandatory verification requirements in sub-issue descriptions
  - Child agents must provide detailed verification instructions (commands, expected outcomes, visual evidence)
  - Parents gain filesystem permissions to child worktrees during verification process
  - No more "verification theater" - actual executable validation required before merging child work
- **@cyrus /label-based-prompt command**: New special command for mention-triggered sessions
  - Use `@cyrus /label-based-prompt` in comments to trigger label-based prompts instead of mention prompts
  - Automatically determines and includes appropriate system prompts based on issue labels
  - Maintains full backwards compatibility with regular `@cyrus` mentions
  - Logged as "label-based-prompt-command" workflow type for easy identification
- **Tool restriction configuration**: New `disallowedTools` configuration option to explicitly block specific tools
  - Can be configured at global, repository, prompt type, and label-specific levels
  - Follows same hierarchy as `allowedTools` (label > prompt defaults > repository > global)
  - No default disallowed tools - only explicitly configured tools are blocked
  - Environment variable support: `DISALLOWED_TOOLS` for global defaults
  - Passed through to Claude Code via `disallowedTools` option
- **New Linear MCP tool**: `linear_agent_session_create_on_comment` for creating agent sessions on root comments
  - Enables orchestrator agents to trigger sub-agents on existing issue comment threads
  - Must be used with root comments only (not replies) due to Linear API constraints
  - Maintains parent-child session mapping for proper feedback routing

### Changed
- Updated @anthropic-ai/claude-code from v1.0.90 to v1.0.95 for latest Claude Code improvements. See [Claude Code v1.0.95 changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md#1095)
- Replaced external cyrus-mcp-tools MCP server with inline tools using SDK callbacks for better performance
- Cyrus tools (file upload, agent session creation, feedback) now run in-process instead of via separate MCP server
- Enhanced orchestrator prompt to explicitly require reading/viewing all screenshots taken for visual verification

### Removed
- Removed cyrus-mcp-tools package in favor of inline tool implementation

## [0.1.45] - 2025-08-28

### Added
- New `cyrus-mcp-tools` package providing MCP tools for Linear integration
  - File upload capability: Upload files to Linear and get asset URLs for use in issues and comments
  - Agent session creation: Create AI/bot tracking sessions on Linear issues
  - **Give feedback tool: Allows parent sessions to send feedback to child sessions**
  - Automatically available in all Cyrus sessions without additional configuration
- PostToolUse hook integration for tracking parent-child agent session relationships
  - Automatically captures child agent session IDs when linear_agent_session_create tool is used
  - **Triggers child session resumption when linear_agent_give_feedback tool is used**
  - Maintains mapping of child sessions to parent sessions for hierarchical tracking
  - **Persistent storage of child-to-parent mappings across restarts**
  - Child session results are automatically forwarded to parent sessions upon completion
- New "orchestrator" label system prompt type
  - Joins existing "builder", "debugger", and "scoper" labels as a default option
  - Configured with read-only tools (cannot directly edit files)
  - Specializes in coordination and oversight of complex development tasks
  - Automatically triggered by "Orchestrator" label on Linear issues
- **Label-based Claude model selection**: You can now override the Claude model used for specific issues by adding labels
  - Add "opus", "sonnet", or "haiku" label to any Linear issue to force that model
  - Model labels take highest priority (overrides both repository and global settings)
  - Case-insensitive label matching for flexibility
  - Automatically sets appropriate fallback models (opus→sonnet, sonnet→haiku, haiku→haiku)

### Changed
- Updated @anthropic-ai/claude-code from v1.0.88 to v1.0.89 for latest Claude Code improvements. See [Claude Code v1.0.89 changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md#1089)
- Upgraded @linear/sdk from v38/v55 to v58.0.0 across all packages for latest Linear API features
- Enhanced ClaudeRunner and EdgeWorker to support Claude Code SDK hooks for tool interception

### Packages

#### cyrus-mcp-tools
- cyrus-mcp-tools@0.3.0 - Already published (not part of this release)

#### cyrus-core
- cyrus-core@0.0.11

#### cyrus-claude-runner
- cyrus-claude-runner@0.0.23

#### cyrus-edge-worker
- cyrus-edge-worker@0.0.28

#### cyrus-ndjson-client
- cyrus-ndjson-client@0.0.17

#### cyrus-ai (CLI)
- cyrus-ai@0.1.45

## [0.1.44] - 2025-08-19

### Changed
- Updated @anthropic-ai/claude-code dependency to use exact version (1.0.83) instead of caret range for improved consistency
- Updated CLAUDE.md documentation with clearer MCP Linear integration testing instructions

### Packages

#### cyrus-claude-runner
- cyrus-claude-runner@0.0.22

#### cyrus-edge-worker
- cyrus-edge-worker@0.0.27

#### cyrus-ai (CLI)
- cyrus-ai@0.1.44

## [0.1.43] - 2025-08-18

### Added
- Model configuration support for Claude Pro users
  - Configure Claude model selection (priority order: env vars → repository config → global config → defaults)
  - Environment variables: `CYRUS_DEFAULT_MODEL` and `CYRUS_DEFAULT_FALLBACK_MODEL`
  - Global config: `defaultModel` and `defaultFallbackModel` in `~/.cyrus/config.json`
  - Repository-specific: `model` and `fallbackModel` fields per repository
  - Defaults: `"opus"` (primary) and `"sonnet"` (fallback)
  - Resolves errors for Claude Pro users who lack Opus model access

### Changed
- Updated @anthropic-ai/claude-code from v1.0.81 to v1.0.83 for latest Claude Code improvements. See [Claude Code v1.0.83 changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md#1083)

### Fixed
- Fixed git worktree creation failures for sub-issues when parent branch doesn't exist remotely
  - Added proper remote branch existence checking before attempting worktree creation
  - Gracefully falls back to local parent branch or default base branch when remote parent branch is unavailable

### Packages

#### cyrus-claude-runner  
- cyrus-claude-runner@0.0.21

#### cyrus-edge-worker
- cyrus-edge-worker@0.0.26

#### cyrus-ai (CLI)
- cyrus-ai@0.1.43

## [0.1.42] - 2025-08-15

### Changed
- Updated @anthropic-ai/claude-code from v1.0.77 to v1.0.80 for latest Claude Code improvements. See [Claude Code v1.0.80 changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md#1080)
- Updated @anthropic-ai/sdk from v0.59.0 to v0.60.0 for latest Anthropic SDK improvements

### Fixed
- Fixed issue where duplicate messages appeared in Linear when Claude provided final responses
  - Added consistent LAST_MESSAGE_MARKER to all prompt types to ensure Claude includes the special marker in final responses
  - Marker is automatically removed before posting to Linear, preventing duplicate content

### Packages

#### cyrus-core
- cyrus-core@0.0.10

#### cyrus-claude-runner  
- cyrus-claude-runner@0.0.20

#### cyrus-edge-worker
- cyrus-edge-worker@0.0.25

#### cyrus-ndjson-client
- cyrus-ndjson-client@0.0.16

#### cyrus-ai (CLI)
- cyrus-ai@0.1.42

## [0.1.41] - 2025-08-13

### Added
- Dynamic tool configuration based on system prompt labels
  - Restrict Claude's tools per task type: give debugger mode only read access, builder mode safe tools, etc.
  - Use case: scoper can only read files, debugger can't use Bash, builder gets full access
  - Use presets (`"readOnly"`, `"safe"`, `"all"`) or custom tool lists in your `labelPrompts` config
  - Improves security and keeps Claude focused on the right tools for each job
  - See [Configuration docs](https://github.com/ceedaragents/cyrus#configuration) for setup details

### Changed
- Updated @anthropic-ai/claude-code from v1.0.72 to v1.0.73 for latest Claude Code improvements

### Fixed
- Fixed Windows compatibility issues that caused agent failures on Windows systems
  - Replaced Unix-specific `mkdir -p` commands with cross-platform Node.js `mkdirSync` 
  - Implemented intelligent shell script detection supporting Windows (.ps1, .bat, .cmd) and Unix (.sh) scripts
  - Added graceful fallback for Windows users with Git Bash/WSL to still use bash scripts
  - Resolves "A subdirectory or file -p already exists" and "bash command not found" errors
- Resolved issue where Cyrus would fail to respond when it was initially delegated when the receiver was down
  - Now properly creates new sessions when prompted if none existed
  - Sessions are correctly initialized even when no prior session history exists
  - Improved code organization and type safety in session handling logic

### Packages

#### cyrus-core
- cyrus-core@0.0.10

#### cyrus-claude-runner  
- cyrus-claude-runner@0.0.19

#### cyrus-edge-worker
- cyrus-edge-worker@0.0.24

#### cyrus-ndjson-client
- cyrus-ndjson-client@0.0.16

#### cyrus-ai (CLI)
- cyrus-ai@0.1.41

## [0.1.40] - 2025-08-10

### Added
- Customer subscription validation for Cyrus Pro users
  - Automatically checks subscription status when using the default proxy with a customer ID
  - Blocks access if subscription is expired, cancelled, or invalid
  - Shows appropriate messages for returning customers vs new customers
  - Validates subscription when setting customer ID via `cyrus set-customer-id` command
- Label-based repository routing - Route Linear issues to different git repositories based on their labels
  - New `routingLabels` configuration option allows specifying which labels should route to a specific repository
  - Useful when multiple repositories handle issues from the same Linear team (e.g., backend vs frontend repos)
  - Label routing takes precedence over team-based routing for more granular control

### Changed
- Updated Linear SDK from v54 to v55.1.0 to support Agent Activity Signals
  - Stop button in Linear UI now sends a deterministic `stop` signal that Cyrus responds to immediately
  - When you click the stop button while Cyrus is working, it will cleanly halt all operations and confirm the stop action
  - The stop signal implementation ensures no work continues after the stop is requested
- Updated Anthropic AI SDK from v0.57.0 to v0.59.0 and Claude Code from v1.0.61 to v1.0.72 for improved Claude integration

### Packages

#### cyrus-core
- cyrus-core@0.0.9

#### cyrus-claude-runner  
- cyrus-claude-runner@0.0.18

#### cyrus-edge-worker
- cyrus-edge-worker@0.0.23

#### cyrus-ndjson-client
- cyrus-ndjson-client@0.0.15

#### cyrus-ai (CLI)
- cyrus-ai@0.1.40

## [0.1.39] - 2025-08-08

### Changed
- Simplified initial setup by removing configuration prompts for MCP, labels, Linear teams, allowed tools, and workspace directory
  - MCP configuration is now optional with no default prompt
  - Allowed tools default to all standard tools plus Bash(git:*) and Bash(gh:*) for immediate productivity
  - Label-based system prompts now have defaults: "Bug" for debugger mode, "Feature,Improvement" for builder mode, and "PRD" for scoper mode
  - Team-based routing defaults to all workspace issues (no team filtering)
  - Workspace directory automatically uses `~/.cyrus/workspaces/<repo-name>`
  - Streamlined first-time user experience with sensible defaults

### Added
- Configuration documentation in README explaining all customizable settings
- Link to configuration docs in CLI output after setup completion

### Fixed
- Fixed duplicate OAuth authorization messages during Linear login flow while ensuring browser still opens automatically

### Packages

#### cyrus-core
- cyrus-core@0.0.8

#### cyrus-claude-runner
- cyrus-claude-runner@0.0.17

#### cyrus-edge-worker
- cyrus-edge-worker@0.0.22

#### cyrus-ndjson-client
- cyrus-ndjson-client@0.0.15

#### cyrus-ai (CLI)
- cyrus-ai@0.1.39

## [0.1.38] - 2025-08-06

### Added
- Native Linear attachments (like Sentry error links) are now included in the issue context sent to Claude
  - Cyrus now fetches attachments using Linear's native attachment API
  - Attachments appear in a dedicated "Linear Issue Links" section in the prompt
  - Particularly useful for Sentry error tracking links and other external integrations
- New command **`cyrus add-repository`** - Add a new repository configuration, thanks new contributor @Maxim-Filimonov !
- Attachment support for comments - Cyrus now downloads and provides access to attachments added in Linear comments
  - Attachments are automatically downloaded when users post comments with URLs or files
  - Downloaded to `~/.cyrus/<workspace>/attachments` directory
  - Attachment manifest is generated and included in Claude's prompt
  - Attachments directory is always available to Claude during sessions
- Differentiation between issue delegation and @ mentions for more focused responses
  - @ mentions now trigger focused responses without system prompts
  - Delegations continue to use full system prompts for comprehensive task handling
  - Aligns with Linear's expected agent activity behavior
- Subscription management built right into the CLI (because who wants another dashboard?)
  - `cyrus billing` - Opens your Stripe portal to manage subscription, payment methods, and download invoices
  - `cyrus set-customer-id` - Saves your customer ID after signup (copy-paste friendly)
  - Interactive prompt on startup if you're using our proxy without a subscription
  - Self-hosting option for the DIY crowd who prefer their own Linear app and infrastructure
  - existed in v0.1.34 but was missing since then

### Fixed
- Fixed attachments not being accessible to Claude during active streaming sessions
  - Pre-create attachments directory for every session to ensure future attachments are accessible
  - Always include attachments directory in allowedDirectories configuration
- Fixed issue where messages from @ Cyrus mention comments weren't being added to context
- Fixed issue where sub-issue base branches weren't being added to the user-prompt template, causing Cyrus to create PRs against the default branch instead

### Packages

#### cyrus-core
- cyrus-core@0.0.8

#### cyrus-claude-runner
- cyrus-claude-runner@0.0.16

#### cyrus-edge-worker
- cyrus-edge-worker@0.0.21

#### cyrus-ndjson-client
- cyrus-ndjson-client@0.0.15

#### cyrus-ai (CLI)
- cyrus-ai@0.1.38

## [0.1.37] - 2025-08-03

### Fixed
- Fixed "RateLimit exceeded" and `Cannot query field "agentContext" on type "AgentActivity".` errors when interacting with Linear API by updating SDK from v52 to v54
  - Linear API had breaking changes that caused compatibility issues with SDK v52
  - The outdated SDK was triggering excessive API calls leading to rate limit errors
  - Upgrading to v54 resolves these compatibility issues and restores normal operation

### Packages

#### cyrus-core
- cyrus-core@0.0.8

#### cyrus-claude-runner
- cyrus-claude-runner@0.0.15

#### cyrus-edge-worker
- cyrus-edge-worker@0.0.20

#### cyrus-ndjson-client
- cyrus-ndjson-client@0.0.15

#### cyrus-ai (CLI)
- cyrus-ai@0.1.37

## [0.1.36] - 2025-08-01

### Added
- Instant response is now sent when receiving follow-up messages in an existing conversation, providing immediate feedback that Cyrus is working on the request
  - Shows "I've queued up your message as guidance" when Cyrus is still processing a previous request
  - Shows "Getting started on that..." when Cyrus is ready to process the new request immediately
- Parent branch inheritance for sub-issues - sub-issue branches now automatically use their parent issue's branch as the base instead of the default repository branch
  - Maintains proper Git hierarchy matching Linear's issue structure
  - Gracefully falls back to default base branch if parent branch doesn't exist
  - Clear logging shows branch inheritance decisions
- Model notification at thread initialization - Cyrus now announces which Claude model is being used (e.g., "Using model: claude-3-opus-20240229") when starting work on an issue
- Task tool execution markers in Linear comments - Cyrus now clearly indicates when automated Task tools are running
  - Tools invoked within a Task display "↪ ToolName" to indicate they're part of the Task
  - Shows "✅ Task Completed" when the Task finishes and displays the output from the Task

### Packages

#### cyrus-core
- cyrus-core@0.0.7

#### cyrus-claude-runner
- cyrus-claude-runner@0.0.14

#### cyrus-edge-worker
- cyrus-edge-worker@0.0.19

#### cyrus-ndjson-client
- cyrus-ndjson-client@0.0.14

#### cyrus-ai (CLI)
- cyrus-ai@0.1.36
## [0.1.35-alpha.0] - 2025-07-27

### Added
- Instant acknowledgment responses when Cyrus receives a request, providing immediate feedback to users
- Role mode notifications when issue labels trigger specific workflows (e.g., "Entering 'debugger' mode because of the 'Bug' label")
- You can now append custom instructions to Claude's system prompt via `appendInstruction` in repository config (~/.cyrus/config.json) - because sometimes Claude needs a gentle reminder that your variable names are art, not accidents

### Changed
- TodoWrite tool messages are now displayed as "thoughts" instead of "actions" in Linear for better visual organization

### Packages

#### cyrus-core
- cyrus-core@0.0.6-alpha.0

#### cyrus-claude-runner
- cyrus-claude-runner@0.0.13-alpha.0

#### cyrus-edge-worker
- cyrus-edge-worker@0.0.18-alpha.0

#### cyrus-ndjson-client
- cyrus-ndjson-client@0.0.13-alpha.0

#### cyrus-ai (CLI)
- cyrus-ai@0.1.35-alpha.0

## [0.1.33] - 2025-07-11

### CLI
- cyrus-ai@0.1.33

### Fixed
- Made conversation history of threads be resumable after Cyrus restarts
- Fixed the issue with continuity of conversation in a thread, after the first comment

### Packages

#### cyrus-core
- cyrus-core@0.0.6

#### cyrus-claude-runner
- cyrus-claude-runner@0.0.13

#### cyrus-edge-worker
- cyrus-edge-worker@0.0.18

#### cyrus-ndjson-client
- cyrus-ndjson-client@0.0.13

## [0.1.32] - 2025-07-09

### CLI
- cyrus-ai@0.1.32

### Fixed
- Missing prompt template file in published package (the one thing you need to actually run the thing)

### Packages

#### cyrus-edge-worker
- cyrus-edge-worker@0.0.17
  - Fixed missing prompt-template-v2.md in package files

## [0.1.31] - 2025-07-09

### CLI
- cyrus-ai@0.1.31

### Added
- Work on multiple tasks within a single Linear issue - each comment thread maintains its own Claude session, letting you tackle different parts of a problem in parallel without context mixing. New root comments start focused sessions that see the full conversation history in a threaded view (just like Linear's UI) while concentrating on your specific request
- Automatic ngrok tunnel setup for external access
  - No more manual port forwarding or reverse proxy setup required
  - Cyrus will ask for your ngrok auth token on first run and handle the rest
  - Free ngrok account required (sorry, we can't make the internet work by magic alone)
  - Skip ngrok setup if you prefer to handle networking yourself
- Webhook debugging via `CYRUS_WEBHOOK_DEBUG=true` environment variable - see exactly what Linear is (or isn't) sending you

### Fixed
- Fresh startup no longer crashes with "EdgeWorker not initialized" error when trying to connect to Linear
- OAuth flow now works properly on first run (turns out asking for credentials before having a way to receive them was... problematic)
- Git worktrees now work with local-only repositories (no more "fatal: 'origin' does not appear to be a git repository" when you're just trying to test things locally)
- Webhooks now register with the correct URL (ngrok/public URL instead of localhost)

### Packages

#### cyrus-edge-worker
- cyrus-edge-worker@0.0.16
- Added ngrok tunnel support for automatic public URL generation
- Fixed webhook URL registration to use public URLs
- Added getPublicUrl() method to SharedApplicationServer

#### cyrus-ndjson-client
- cyrus-ndjson-client@0.0.12
- Fixed webhook URL registration to use external server's public URL when available

## [0.1.30] - 2025-07-07

### CLI
- cyrus-ai@0.1.30

### Fixed
- Fixed critical crash issue where subprocess failures would bring down the entire application
  - Added global error handlers to prevent uncaught exceptions from terminating the process
  - Improved error isolation for individual Claude sessions - failures no longer affect other running sessions
  - Enhanced error logging with detailed stack traces for better debugging

### Packages

#### cyrus-edge-worker
- cyrus-edge-worker@0.0.15

## [0.1.28] - 2025-07-06

### CLI
- cyrus-ai@0.1.28

### Fixed
- Fixed critical streaming hang where sessions would never complete
  - Auto-completes streaming prompt when Claude sends result message
  - Prevents infinite wait in for-await loop

## [0.1.27] - 2025-07-06

### CLI
- cyrus-ai@0.1.27

### Changed
- Updated to use edge-worker 0.0.12 with fixed claude-runner dependency

## [0.1.26] - 2025-07-06

### CLI
- cyrus-ai@0.1.26

### Fixed
- Fixed critical streaming hang issue where Claude Code would block waiting for messages
  - Corrected `abortController` placement in query options (was at wrong nesting level)
  - Fixed system prompt parameter name (now uses `customSystemPrompt` as expected by Claude Code)

### Added
- Added `appendSystemPrompt` option to ClaudeRunner config for extending default system prompt

## [0.1.25] - 2025-07-06

### CLI
- cyrus-ai@0.1.25

### Fixed
- Fixed streaming session detection to prevent "I've queued up your message..." when sessions have completed
- Improved isStreaming() method to check both streaming state and session running status


## [0.1.23] - 2025-07-06

### CLI
- cyrus-ai@0.1.23

### Fixed
- Fixed streaming input sessions not properly cleaning up after completion
  - Resolves issue where "I've queued up your message..." appeared even after sessions had resolved
  - Properly closes input streams when Claude sessions complete naturally

### Added
- Added `cyrus check-tokens` command to validate all Linear OAuth tokens across repositories
- Added `cyrus refresh-token` command with OAuth flow integration to renew expired tokens
- Improved error handling for expired Linear tokens with graceful degradation
  - Shows clear error messages with suggested resolution steps
  - Continues running with valid repositories when some tokens are expired

### Changed
- Configuration file location moved from `.edge-config.json` in current directory to `~/.cyrus/config.json`
  - Automatically migrates existing `.edge-config.json` files to the new location
  - Uses standard user configuration directory for better cross-platform compatibility
  - Reports migration status when detected
- Default workspace directory changed from `{repository}/workspaces` to `~/.cyrus/workspaces/{repo-name}`
  - Centralizes all cyrus-related files in the user's home directory
  - Uses sanitized repository names as namespace folders
  - Existing configurations remain unchanged

## [0.1.22] - 2025-07-05

### CLI
- cyrus-ai@0.1.22

### Added
- Automatic Linear MCP (Model Context Protocol) server integration
  - Claude can now use Linear API tools directly within sessions
  - Automatically configures `@tacticlaunch/mcp-linear` server with repository's Linear token
  - Adds 30+ Linear MCP tools for issue management, comments, projects, and more
  - No additional configuration needed - works out of the box with existing Linear tokens

### Changed
- ClaudeRunner now supports array of MCP config paths for composable configurations
- ClaudeRunner supports inline MCP server configurations alongside file-based configs
- MCP configurations from files and inline sources are merged together

### Fixed
- Fixed webhook signature verification failures after restarting cyrus by extending edge worker registration TTL from 1 hour to 90 days
  - Resolves "Webhook signature verification failed for all registered handlers" error that occurred when cyrus was stopped and restarted
  - Edge worker registrations in the proxy now persist for 90 days instead of expiring after 1 hour

### Improved
- New comments on Linear issues queue up when Cyrus is already busy working, so that you can send multiple in a row ([#77](https://github.com/ceedaragents/cyrus/pull/77)) (now feed into existing Claude sessions instead of killing and restarting the session

### Packages

#### cyrus-claude-runner
- cyrus-claude-runner@0.0.8

#### cyrus-edge-worker
- cyrus-edge-worker@0.0.10

## [0.1.21] - 2025-07-05

### CLI
- cyrus-ai@0.1.21

### Added
- Added `CYRUS_HOST_EXTERNAL` environment variable to enable external server access ([#78](https://github.com/ceedaragents/cyrus/pull/78))
  - Set to `true` to listen on `0.0.0.0` (all interfaces) instead of `localhost`
  - Enables Docker container deployment and external webhook access scenarios
  - Maintains backward compatibility with `localhost` as default

### Changed
- **BREAKING**: Renamed `CYRUS_WEBHOOK_BASE_URL` to `CYRUS_BASE_URL` for clearer naming
  - **Action Required**: Update environment configuration to use `CYRUS_BASE_URL` instead of `CYRUS_WEBHOOK_BASE_URL`
  - **Legacy Support**: `CYRUS_WEBHOOK_BASE_URL` is still supported for backward compatibility but deprecated
  - The variable serves both webhook and OAuth callback purposes since they run on the same server

### Packages

#### cyrus-edge-worker
- cyrus-edge-worker@0.0.9

## [0.1.19] - 2025-07-04

### CLI
- cyrus-ai@0.1.19

### Added
- Added `CYRUS_OAUTH_CALLBACK_BASE_URL` environment variable to configure OAuth callback URL (defaults to `http://localhost:3457`) ([#69](https://github.com/ceedaragents/cyrus/pull/69))
- Added `CYRUS_OAUTH_CALLBACK_PORT` environment variable to configure OAuth callback port (defaults to `3457`)
- OAuth callback URL is now fully configurable for different deployment environments (Docker, remote development, custom domains)
- Supports `--env-file=path` option to load environment variables from custom file
- Added `CYRUS_BASE_URL` environment variable to configure base URL for edge workers ([#74](https://github.com/ceedaragents/cyrus/pull/74))
- Added `CYRUS_WEBHOOK_PORT` environment variable to configure webhook port (defaults to random port 3000-3999)
- Implemented shared webhook server architecture to eliminate port conflicts between multiple Linear tokens

### Changed
- **BREAKING**: Migrated from Server-Sent Events (SSE) to webhook-only architecture ([#74](https://github.com/ceedaragents/cyrus/pull/74))
  - **Action Required**: Edge workers now receive webhooks instead of SSE streams
  - **Action Required**: Set `CYRUS_BASE_URL` environment variable if using custom deployment URLs (e.g., ngrok tunnel, server domain)
  - **Action Required**: Set `CYRUS_WEBHOOK_PORT=3456` environment variable to ensure consistent webhook port
  - **Action Required**: Ensure edge workers can receive inbound HTTP requests on webhook ports
- Renamed repository setup script from `secretagentsetup.sh` to `cyrus-setup.sh`

### Fixed
- Resolved SSE connection reliability issues by migrating to webhook architecture
- Improved disconnection message formatting
- Removed duplicate disconnection logging

### Packages

#### cyrus-claude-runner
- Upgraded @anthropic-ai/claude-code dependency to version 1.0.31

## [0.0.3] - 2025-06-17

### Packages
- cyrus-claude-runner@0.0.3
- cyrus-core@0.0.3
- cyrus-edge-worker@0.0.3
- cyrus-ndjson-client@0.0.3

Initial changelog entry

## [0.1.9] - 2025-06-17

### CLI
- cyrus-ai@0.1.9

Initial changelog entry
