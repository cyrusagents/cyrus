# Checklist: new agent CLI harness

Use when implementing a new runner/harness (Cursor, OpenCode, Gemini, or other
CLIs). Pair with the `new-agent-harness` skill. Treat tool-lifecycle mapping as a
first-class acceptance criterion, not a formatter-only concern.

## 1) Session lifecycle and turn limits

- Verify turn-limit behavior (`maxTurns`, `maxSessionTurns`, or equivalent).
- Confirm what error/result payload is emitted when limits are exceeded.
- Ensure session stop behavior is explicit and deterministic.

## 2) Prompt model and instructions

- Identify how the base system prompt is applied.
- Identify whether appended instructions extend or replace defaults.
- Confirm provider-specific instruction fields (e.g. `developer_instructions`)
  and expected precedence.

## 3) Streaming event schema

- Capture real JSON event streams and document item types.
- Determine whether events are full objects or deltas/partials that need
  aggregation.
- Add replay tests from real transcripts.

## 4) Final message semantics

- Verify where the final answer lives:
  - in a `result` payload (Claude-style), or
  - in the last assistant message (Gemini-style), or
  - mixed model/event behavior.
- Always post a final `response` activity when work completes successfully.

## 5) Tools and permissions

- Validate `tools`, `allowedTools`, and `disallowedTools` semantics for the SDK.
- Validate approval/sandbox behavior for tool execution.
- Verify tool calls produce both start and completion signals.
- For providers that rely on static/project config files (e.g. Cursor CLI):
  implement a permission translation layer from Cyrus/Claude tool names to
  provider-native permission tokens and write that config before session start.
  Support subroutine-time updates when allowed/disallowed tools change.
  Pre-enable MCP servers before session start so tools are available in headless
  runs. For broad file permissions, map wildcard `Read(**)` / `Write(**)` to
  workspace-scoped patterns (e.g. `Read(./**)` / `Write(./**)`).
  - Cursor MCP config locations: https://cursor.com/docs/context/mcp#configuration-locations
  - Cursor permissions: https://cursor.com/docs/cli/reference/permissions

## 6) Prompt streaming input

- Verify whether the SDK supports streaming/incremental prompt input.
- Set `supportsStreamingInput` correctly and gate behavior in runner adapters.

## 7) MCP servers and custom tools

- Verify MCP server config format and merge behavior.
- Verify custom tool registration/invocation behavior.
- Map MCP/custom-tool events into consistent runner message shapes.

## 8) Runner selection via labels and description selectors

- Keep agent label and model label separate (example: `cursor` and
  `composer-2.5`).
- Support issue description selectors like `[agent=...]`, `[model=...]`,
  `[repo=...]`.
- Add precedence tests for labels vs selectors vs repository defaults.

## 9) Activity formatting and timeline visibility

- Ensure formatter output is timeline-ready (AgentActivity content fields).
- Ensure tool lifecycle events are visible as activities (not silently dropped).
- Use Markdown-compatible checklists: `- [ ] item` / `- [x] item`.

## 10) Usage, stop reasons, and typing

- Map usage/cost/stop-reason fields to expected shared types.
- Fill required compatibility fields even when the provider omits them natively.
- Keep strict TypeScript compatibility for cross-runner shared contracts.

## 11) Config schema and backward compatibility

- Use provider-specific defaults (`claudeDefaultModel`, `cursorDefaultModel`, and
  matching fallback fields).
- Add config migration logic for renamed or legacy fields.
- Keep docs/comments provider-specific and explicit.

## 12) Validation protocol before merge

- Unit tests for new runner adapters and formatter behavior.
- Replay tests from real CLI transcripts.
- F1 end-to-end scenarios for:
  - label-based runner/model selection
  - description selector-based runner/model selection
  - visible tool/file-edit activities in the session timeline
  - final response posting behavior

## Lesson learned: harness tool lifecycle

Some providers emit tool activity at lifecycle events that do not map 1:1 to
`tool_use` / `tool_result`. If those events are not mapped in the runner
adapter, action/file-edit visibility in Linear is lost.

## Lesson learned: Cursor integration

Cursor CLI permissions are enforced from config
(`~/.cursor/cli-config.json` or `<project>/.cursor/cli.json`) instead of dynamic
per-request tool allowlists. Do not rely on dynamic SDK tool constraints alone —
add a translation layer (e.g. `mcp__server__tool` → `Mcp(server:tool)`,
`Bash(...)` → `Shell(...)`) and sync project permissions before each run and
between subroutines. Pre-enable MCP servers via `agent mcp list` +
`agent mcp enable <server>` using both project-listed and runner-configured
server names. Treat `.cursor/mcp.json` as the project MCP source. Use
workspace-scoped wildcards (`Read(./**)`, `Write(./**)`) rather than unscoped
`Read(**)` / `Write(**)`.
