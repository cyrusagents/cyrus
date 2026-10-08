# Test Drive: Claude Agent SDK 0.3.293 runtime (CYPACK-1569)

**Date:** 2026-10-08 00:40 PDT

**Result:** **PARTIAL — initialization passed; authenticated model execution blocked.**

**Tested tree:** local CYPACK-1569 changes on base `53534e9fa014b56d07842d84dba152410d161a28`

**Fixture:** `/private/tmp/cypack-1569-f1.kbfZ8o/repo`

## Changed behavior and assertions

The Agent SDK advances from 0.3.281 to
[0.3.293](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md#03293).
The accumulated update changes permission-mode selection, background-task
ordering and metadata, MCP result envelopes, partial-message completion, and
interrupted-turn replay. Version 0.3.293 additionally exposes an optional
`subagent_type` on `background_tasks_changed` entries.

SDK 0.3.286 delegates an omitted permission mode to Claude Code, which can
select a settings default or automatic mode. Cyrus now passes
`permissionMode: "default"` explicitly so its existing tool rules and
`canUseTool` callback keep governing approvals.

The fixture committed `.claude/settings.local.json` with
`permissions.defaultMode=acceptEdits`, and the F1 server ran with
`DISABLE_TELEMETRY=1`. The real `claude_query_options` event reported:

- `cqo.permissionMode=default`;
- all three setting sources (`user`, `project`, `local`);
- 30 built-in tools plus four scoped read allowances; and
- `hasCanUseTool=true`.

This passes the changed initialization behavior through the real EdgeWorker and
ClaudeRunner path. The mandatory tool extraction independently reported the
same 30-tool SDK registry as `packages/claude-runner/src/config.ts`, so the
allowance catalog needs no further edit.

## F1 results

- The server started on port 3600 and reported healthy/ready.
- `issue-1` / `DEF-1` was created and routed to the primary F1 repository
  after the repository-selection prompt.
- `session-1` created its worktree and assigned Claude session
  `10f469d6-2af5-4a61-8c19-0cbcbc0a8a1d`.
- Routing, model selection, and the terminal authentication error were rendered
  as timestamped activities.
- `stop-session` succeeded and SIGINT shut down the server cleanly.

## Authentication blocker

The installed Claude identity returned HTTP 401: `OAuth access token has
expired. Re-authenticate to continue.` No Read or Bash call and no
`SDK_RUNTIME_OK` response occurred, so authenticated end-to-end execution is
not claimed. This is the same external credential blocker recorded by the
superseded CYPACK-1566 drive.

After the existing identity is reconnected through supported browser login,
repeat the drive against the final pushed SHA. Require a Read of
`package.json`, foreground Bash `pwd` with `timeout: 10000`, the exact final
response `SDK_RUNTIME_OK`, and a clean stop. An init event, an OAuth failure,
or the marker merely appearing in the prompt does not satisfy this gate.

## Targeted verification

- `pnpm install` — passed.
- `pnpm build` — passed.
- `pnpm --filter cyrus-claude-runner test:run` — 129 passed.
- `pnpm audit` — zero advisories.
- `./scripts/extract-claude-tools.sh` — 30 tools, no catalog changes.
- Published `cyrus-core@0.2.74-test.8` under the npm `test` tag; the
  `latest` tag remained `0.2.73`. The published core depends on Agent SDK
  0.3.293 and does not depend on `cyrus-claude-runner`, so no runner
  prerelease was required for the Hosted pin.

## Compatibility decisions

Reviewed primary sources:

- [Agent SDK 0.3.281 → 0.3.293](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md#03293)
- [API SDK 0.128.0 → 0.132.1](https://github.com/anthropics/anthropic-sdk-typescript/releases/tag/sdk-v0.132.1)

The explicit permission-mode regression covers first-party, Bedrock, Vertex,
Foundry, telemetry-disabled, and do-not-track configurations while preserving
settings files. The pending-work lifecycle test accepts the SDK's updated task
event ordering without treating informational task frames as stream
termination. Parameterized runner tests preserve detached tool-call,
structured-content-omission, and MCP `_meta` result envelopes as opaque
metadata.

Cyrus does not directly parse the new `subagent_type`, `agent_id`,
`parent_task_id`, `run_id`, notification timestamps, or ListAgents
sections/notes. They remain additive metadata. The app also does not use the API
SDK path-parameter behavior fixed in 0.132.1, so no call-site migration is
required; build and typecheck cover the imported message contracts.

Background command deadlines, priority input, SDK-managed MCP protocol
negotiation, and replay/resume fixes are accepted upstream behavior. Cyrus
continues consuming the iterator until it ends, retains its queued input policy,
and derives activity text from message content rather than optional
`tool_use_result` metadata.
