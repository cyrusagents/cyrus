# Test Drive: Claude Agent SDK 0.3.295 runtime (CYPACK-1571)

**Date:** 2026-10-09 00:27 PDT

**Result:** **PARTIAL — initialization passed; authenticated model execution blocked.**

**Tested tree:** local CYPACK-1571 changes on base `9cb20212eb27335bddc63f9f413a69d3b21e977c`

**Fixture:** `/private/tmp/cypack-1571-f1.NbD8bh/repo`

## Changed behavior and assertions

The Agent SDK advances from 0.3.281 to
[0.3.295](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md#03295).
The accumulated update changes permission-mode selection, background-task
ordering and metadata, MCP result envelopes and limits, partial-message
completion, interrupted-turn replay, and streamed citation handling.

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
  `ccfbeebb-5ac5-4150-86c0-1c0fada1d160`.
- Routing, model selection, and the terminal authentication error were rendered
  as timestamped activities; pagination returned the same six coherent rows.
- `stop-session` succeeded and SIGINT shut down the server cleanly.

## Authentication blocker

The installed Claude identity returned HTTP 401: `OAuth access token has
expired. Re-authenticate to continue.` No Read or Bash call and no
`SDK_RUNTIME_OK` response occurred, so authenticated end-to-end execution is
not claimed. This is the same external credential blocker recorded by the
superseded CYPACK-1569 drive.

After the existing identity is reconnected through supported browser login,
repeat the drive against the final pushed SHA. Require a Read of `package.json`,
foreground Bash `pwd` with `timeout: 10000`, the exact final response
`SDK_RUNTIME_OK`, and a clean stop. An init event, an OAuth failure, or the
marker merely appearing in the prompt does not satisfy this gate.

## Targeted verification

- `pnpm install` — passed.
- `pnpm build` — passed.
- `pnpm --filter cyrus-claude-runner test:run` — 129 passed.
- `./scripts/extract-claude-tools.sh` — 30 tools, no catalog changes.
- Published `cyrus-core@0.2.74-test.9` under the npm `test` tag; the
  `latest` tag remained `0.2.73`. The published core depends on Agent SDK
  0.3.295 and does not depend on `cyrus-claude-runner`, so no runner
  prerelease was required for the Hosted pin.

## Compatibility decisions

Reviewed primary sources:

- [Agent SDK 0.3.281 → 0.3.295](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md#03295)
- [API SDK 0.128.0 → 0.132.1](https://github.com/anthropics/anthropic-sdk-typescript/releases/tag/sdk-v0.132.1)

The explicit permission-mode regression covers first-party, Bedrock, Vertex,
Foundry, telemetry-disabled, and do-not-track configurations while preserving
settings files. The pending-work lifecycle test accepts the SDK's updated task
event ordering without treating informational task frames as stream
termination. Parameterized runner tests preserve detached tool-call,
structured-content-omission, and MCP `_meta` result envelopes as opaque
metadata.

Cyrus does not directly parse the additive task, agent, rate-limit, or
notification fields introduced by these releases. The 0.3.295 MCP result-size
limits and command-line option encoding are upstream transport behavior; Cyrus
continues consuming the iterator and deriving activities from message content.
The app also does not use the API SDK empty-path behavior fixed in 0.132.1, so
no call-site migration is required; build and typecheck cover the imported
message contracts.
