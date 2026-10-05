# Anthropic runtime compatibility: CYPACK-1559

This review covers Agent SDK **0.3.281 → 0.3.289**, its bundled Claude Code
**2.1.282–2.1.289**, and Anthropic API SDK **0.128.0 → 0.131.0**.
Upstream references: [Agent SDK changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md)
and [Claude Code changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md).

## Permission decision

Cyrus explicitly passes `permissionMode: "default"` on every `ClaudeRunner`
query, including resumed sessions. This preserves the SDK behavior before
0.3.286. Loading user, project, and local settings still supplies instructions,
hooks, and other settings; their `permissions.defaultMode` no longer chooses
Cyrus's starting permission mode. Provider selection (including Bedrock, Vertex,
and Foundry) and disabling telemetry do not opt Cyrus into the auto classifier.

This preserves the existing approval contract, not a new exclusive allowlist:
`allowedTools` pre-approves tools, explicit `disallowedTools` still denies them,
and the existing `canUseTool` callback handles AskUserQuestion and allows other
requests that reach it. OS sandbox restrictions remain independent. The change
neither enables `bypassPermissions` nor replaces administrator policy.

`test/permission-mode.test.ts` checks the runner boundary, environment variants,
resume, tool rules, and callback preservation. After building, run
`node packages/claude-runner/test-scripts/permission-mode-smoke.mjs` for real
SDK/CLI initialization across settings scopes, three providers, and telemetry-off
flags. It asserts the emitted mode and bundled version, then stops before a model
turn; dummy credentials deliberately make this **not** an authentication test.

## Runtime applicability and handling

| Upstream change | Cyrus applicability and decision |
| --- | --- |
| Code 2.1.285 / SDK 0.3.285 background Bash/PowerShell timeout; Code 2.1.288 restricts it to unattended sessions | Applies to all Cyrus SDK sessions: `run_in_background` now respects `timeout`, defaults to 30 minutes, and caps at two hours. Accept the runtime limit. Jobs needing more time must use an external service/scheduler; specify an explicit supported timeout for shorter jobs. Cyrus's existing Stop-hook pending-work tracking keeps the session alive while background tasks remain, but does not extend their lifetime. PowerShell follows the upstream rule when available; it is not in Cyrus's default tool catalog. No unlimited-time compatibility override. |
| Code 2.1.285 per-tool `anthropic/alwaysLoad: false`; 2.1.287 server `alwaysLoad: false`; SDK 0.3.284 startup wait | Deferred MCP tools remain discoverable through `ToolSearch`, present in all three platform defaults. Retain the SDK's deferral behavior and Cyrus's nonblocking MCP connection setting. Explicitly allowed/hook-referenced servers can still add up to two seconds to first-turn startup even with a zero startup-wait setting. Do not treat absence from eager init tools as server failure or force every tool to load. |
| Code 2.1.282 project/local telemetry env restrictions | Applies because those setting sources are loaded. Repository settings cannot turn on export, redirect collectors, or opt into content capture. Configure intended telemetry in trusted user/managed settings or the host environment. Cyrus's own logging is separate. Do not copy blocked project settings into host env to bypass this rule. |
| Code 2.1.282, 2.1.283, 2.1.285 managed sandbox precedence/validation | Applies on managed hosts: project exclusions cannot escape an enforced sandbox; malformed nested managed values fail closed; project settings cannot widen managed network/filesystem policy. Keep forwarding Cyrus sandbox settings and accept stricter effective administrator policy. Tool deny rules remain in force independently. No policy-weakening compatibility shim. |
| SDK 0.3.287 detached WebFetch/WebSearch | A priority `now` interruption can yield `tool_use_result: { detachedToolCall: true }`, with the real result later. Cyrus currently queues ordinary streaming user messages without priority `now`, so it does not request this path. Runner events retain this optional metadata unchanged; activities read the message's text content, not a presumed structured web result. Any future priority-now API must handle delayed completion explicitly. |
| SDK 0.3.287 large MCP structured results | Above 1,048,576 serialized JSON characters, `structuredContent` is omitted and `structuredContentOmitted` is set, except SDK-server/MCP Apps tools. Cyrus does not depend on this optional metadata: activity content comes from `message.content` tool-result text. Preserve the marker in raw runner events and do not reconstruct missing data or retry the MCP operation (which could duplicate side effects). |

No new built-in tools require recategorization. The dependency update itself
retains the 30-tool catalog and its existing read/write grouping.

## Hosted companion

[cyrus-hosted#1121](https://github.com/cyrusagents/cyrus-hosted/pull/1121), head
`1dfb6f276151e073209f99c4170534108c5f74a0`, pins `cyrus-core@0.2.74-test.4` and
Anthropic API SDK 0.131.0. That published core includes SDK 0.3.289 and the same
platform tool constants; **core does not bundle ClaudeRunner**. The permission
fix is in the separately deployed Cyrus runner, so core does not require another
prerelease for this change.

The companion SQL removes `TaskOutput` only from exact previous defaults for
Linear, Slack, and GitHub. Actual SQL execution in isolated PGlite/Postgres
fixtures verified untouched defaults, already-current defaults, custom lists,
reordered lists, empty arrays, NULLs, mixed-platform rows, and idempotence against
the installed core constants. Existing platform columns intentionally have no
SQL default (see the May 21 platform-tools migration); new teams use NULL and
fall back to core. No production database migration was run.

See the [follow-up validation report](../../apps/f1/test-drives/2026-10-05-cypack-1559-runtime-review.md)
for test results and the live authentication gate.
