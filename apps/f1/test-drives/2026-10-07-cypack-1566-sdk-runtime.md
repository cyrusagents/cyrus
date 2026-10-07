# Test Drive: Claude Agent SDK 0.3.292 runtime (CYPACK-1566)

**Date:** 2026-10-07 00:26 PDT  
**Result:** **PARTIAL — initialization passed; authenticated model execution blocked.**  
**Tested tree:** local CYPACK-1566 changes on base `8e786086b21c8dbbc72683830508517b99a62f05`  
**Fixture:** `/private/tmp/cypack-1566-f1.N6y2mr/repo`

## Changed behavior and assertions

The Agent SDK was advanced from 0.3.281 to 0.3.292. SDK 0.3.286 delegates an
omitted permission mode to Claude Code, which can select settings or automatic
mode. Cyrus now passes `permissionMode: "default"` explicitly.

The fixture committed `.claude/settings.local.json` with
`permissions.defaultMode=acceptEdits` and `DISABLE_TELEMETRY=1`. The F1 server's
real `claude_query_options` event reported:

- `cqo.permissionMode=default`
- all three setting sources (`user`, `project`, `local`)
- 30 refreshed built-in tools plus four scoped read allowances
- `hasCanUseTool=true`

This passes the changed initialization behavior through the real EdgeWorker and
ClaudeRunner path. The mandatory tool extraction independently reported the same
30-tool SDK registry as `packages/claude-runner/src/config.ts`.

## F1 results

- Server started on port 3602 and reported healthy/ready.
- `issue-1` / `DEF-1` routed to the primary F1 repository.
- `session-1` created its worktree and assigned a Claude session ID.
- Routing, model selection, and the terminal authentication error were rendered
  as timestamped activities.
- Offset/limit pagination and `Routing` search returned the expected activities.
- `stop-session` succeeded and SIGINT shut down the server cleanly.

## Authentication blocker

The installed Claude identity returned HTTP 401: `OAuth access token has
expired. Re-authenticate to continue.` No Read or Bash tool call and no
`SDK_RUNTIME_OK` model response occurred, so authenticated end-to-end execution
is not claimed. This is the same external credential blocker recorded by the
superseded CYPACK-1565 drive; reconnecting the existing identity is required to
close that remaining acceptance gate.

## Targeted verification

- `pnpm build` — passed.
- `pnpm --filter cyrus-claude-runner test:run` — 126 passed.
- `pnpm audit` — zero advisories.
- `./scripts/extract-claude-tools.sh` — 30 tools, no catalog changes.
- Published `cyrus-claude-runner@0.2.74-test.2` and
  `cyrus-core@0.2.74-test.7` under the `test` tag; both stable `latest` tags
  remained 0.2.73.

## Review follow-up: compatibility decisions

The run above is historical, unsuccessful evidence from the pre-rebase tree. It
is **not** runtime acceptance for the pushed PR head. The final-head run and CI
links belong in the PR verification comment, keyed by the complete commit SHA;
recording that evidence must not create another untested documentation commit.

Reviewed ranges and primary sources:

- [Agent SDK 0.3.281 → 0.3.292](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md#03292)
- [Claude Code 2.1.281 → 2.1.292](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md#21292)
- [API SDK 0.128.0 → 0.131.0](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/CHANGELOG.md#01310-2026-09-30)

These are upstream compatibility changes, not a list of reproduced Cyrus bugs.
Installed SDK declarations and Cyrus call sites were inspected after `pnpm install`.

### Background deadlines and final-result lifetime

Accept the 2.1.285 change: Bash/PowerShell `timeout` now also limits commands
started with `run_in_background`; the default is 30 minutes and the maximum is
two hours. Cyrus passes tool inputs through, so it must not promise unlimited
background execution. Jobs needing longer must be split or run in a separately
managed service. A timeout is a stopped task, not a successful command result.

Accept 2.1.292's wait for background commands after a final result, replacing
the old five-second teardown. A turn result is not subprocess completion.
`ClaudeRunner` consumes the iterator until it ends; streaming cold sessions
retain input while the Stop hook reports work, and warm sessions keep input
open. Explicit `stop()` still aborts. Preserve this behavior rather than adding
a fixed delay or closing the iterator on the first result. Existing
`pending-work-lifecycle.test.ts` covers cold completion, pending cron/background
work, and warm sessions. The extended background test verifies that completion
notifications do not terminate the session before the later Stop/result pair.
These are mocked lifecycle tests, not live shell deadline measurements.

### Priority input, event order, and MCP result envelopes

In 0.3.286 priority `now` input can background running shell/agent/MCP calls and
join their turn. `StreamingPrompt.addMessage` does not request that priority;
keep Cyrus's existing queued input policy. Do not infer cancellation from a
priority message or infer task completion from a tool placeholder.

In 0.3.292 a finishing task's update/notification precede its changed background
snapshot. Cyrus forwards SDK frames unchanged and serializes activity handling
in `AgentSessionManager.handleClaudeMessage`; its pending-work decision uses
Stop-hook snapshots, not paired task events. The extended lifecycle test replays
this order and asserts that pending work remains until the next Stop snapshot.
No new live task-tree UI is claimed: task system frames are retained in the
runner stream/log but are not individually rendered as activities. New
`agent_id`, `parent_task_id`, `run_id`, notification timestamps and ListAgents
sections/notes remain additive metadata; Cyrus does not parse their display text
or correlate resumed tasks using arrival order.

0.3.287 can return `{ detachedToolCall: true }` for deferred WebFetch/WebSearch,
and omit oversized MCP `structuredContent` with `structuredContentOmitted`.
0.3.290 preserves `_meta` in failed Chrome MCP results using `{ content, _meta }`.
Accept these envelopes as opaque optional metadata. Cyrus activity text comes
from `message.content` tool-result blocks, not the top-level `tool_use_result`;
it must not depend on structuredContent being present. New parameterized
runner tests assert preservation of all three envelopes. They are synthetic
contract fixtures, not recorded real MCP tool executions. Rendering rich MCP
Apps metadata or tracking detached-result completion is outside this update.

### Stdio MCP protocol negotiation

Accept Claude Code 2.1.292's default stdio negotiation toward `2026-07-28`,
including third-party providers. Do not globally force legacy mode. Cyrus passes
MCP configuration to the SDK rather than implementing this negotiation; its
installed MCP SDK 1.31.0 advertises up to `2025-11-25`, so fallback compatibility
matters. For a demonstrated incompatible external server, the upstream scoped
operational escape hatch is `MCP_PROTOCOL_NEGOTIATION=legacy` in the Claude
session environment. Reconnect and verify that server before removing it.

A local auth-independent probe using the installed Agent SDK 0.3.292, no
`MCP_PROTOCOL_NEGOTIATION` override, and a JSON-RPC stdio fixture advertising
`2025-11-25` connected successfully. Observed fixture traffic was `initialize`
with `protocolVersion: "2025-11-25"`, `notifications/initialized`, then
`tools/list`; both init and `mcpServerStatus()` reported `connected`. This proves
that fixture's older-protocol compatibility through the new SDK, not a live
2026-07-28 exchange or compatibility of every configured hosted MCP server.
Hosted external servers still require their own acceptance.

### Permission callback metadata

`suppressAlwaysAllowRule` is an optional callback hint to omit persistent
approval choices. Cyrus's callback returns a decision for that call only; it
neither offers an always-allow UI nor returns `updatedPermissions`. Preserve
that policy. The permission regression now passes `suppressAlwaysAllowRule:
true` and checks the complete result is only `behavior` and `updatedInput`,
without a persistent rule. This does not add a new organization-approval UI or
claim broader policy enforcement. The explicit `permissionMode: "default"`
regression remains in place for settings and provider variations.

### Remaining API and Agent SDK changes

Cyrus's direct API SDK imports in `claude-runner/src/types.ts` are message type
re-exports. It does not call the new Admin APIs, Managed Agents APIs, MCP tunnels,
or API tool runner, so their new fields, turn-ending fixes, and removed
client-side compaction controls need no Cyrus migration. The new model names,
`between_tools` thinking, cache diagnostics, pagination, timeout headers, and
stream parsing fixes are accepted; no Cyrus model defaults change here. Build
and typecheck validate the re-exported message contracts.

Agent SDK fixes to replay/resume, partial-message termination, MCP toggling,
hook elicitation, and initialization ordering are accepted upstream fixes.
Cyrus does not call the new prewarm/core entry point, session-history helpers,
or settings mutation APIs. Keep the full SDK entry point and existing behavior;
no new features are enabled by this dependency update.

## Reconnect handoff and final runtime gate

Preserved from [the prior #1529 handoff](https://github.com/cyrusagents/cyrus/pull/1529#issuecomment-6020547213):
on the same Mac, as OS user `agentops`, reconnect the existing **connor@ceedar.io**
Claude identity, restoring `/Users/agentops/.claude` through supported browser login:

```sh
env -u CLAUDE_CONFIG_DIR -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN \
  -u CLAUDE_CODE_OAUTH_TOKEN \
  /Users/agentops/.local/bin/claude auth login --claudeai --email connor@ceedar.io
```

This agent session cannot write that existing credential store under its
filesystem permissions. `claude auth status` identifying the account is not
proof that the token works. Do not copy credentials or substitute another
identity. After browser sign-in, rebuild the final pushed SHA and run F1 with a
fresh fixture: require a Read of `package.json`, foreground Bash `pwd` with
`timeout: 10000`, and the final response `SDK_RUNTIME_OK`. Stop after 120 seconds
if incomplete. Capture the SDK tool-use/result IDs, successful final result,
timestamped response activity, pagination/search checks, and clean shutdown.
An init block, an OAuth failure, or the marker merely appearing in the prompt
must never satisfy this gate.

## Rebase and proof identities

Rebased onto patched main `53534e9fa014b56d07842d84dba152410d161a28`.
The duplicate security changelog and root override hunks are removed; main's
#1531 remediation and workspace override policy are retained. The regenerated
lockfile differs from main only for the Anthropic SDK update.

- Local runtime proof uses workspace builds of core **and** ClaudeRunner at the
  exact SHA recorded with the run. It is not an installed npm or hosted test.
- Previously verified npm artifacts remain `cyrus-core@0.2.74-test.7` and
  `cyrus-claude-runner@0.2.74-test.2`. Core does **not** contain ClaudeRunner;
  that runner artifact depends on stable `cyrus-core@0.2.73`. No artifact is
  republished or attributed to this rebased head.
- [Hosted #1145](https://github.com/cyrusagents/cyrus-hosted/pull/1145) is separate
  proof. At review follow-up its head was
  `f7561f43d30812808acd173d96122e58d8cd92b1`, with a successful `check`, skipped
  previews and `DIRTY` merge status. It still needs its own rebase and final
  gates. Neither core publication nor this local run closes hosted acceptance.
