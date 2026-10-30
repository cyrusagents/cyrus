# CYPACK-1607: Anthropic SDK 0.3.314 compatibility review

**Date:** 2026-10-30

**Goal:** Advance Cyrus from Claude Agent SDK `0.3.281` to `0.3.314` and Anthropic API SDK `0.128.0` to `1.3.0`, refresh the bundled tool registry, and provide an immutable `cyrus-core` test release for the Hosted companion.

**Pull requests:** [cyrus#1567](https://github.com/cyrusagents/cyrus/pull/1567), [cyrus-hosted#1293](https://github.com/cyrusagents/cyrus-hosted/pull/1293)

## Upstream range and compatibility dispositions

The official [Agent SDK changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md#03314) was reviewed through `0.3.314`, together with the [Anthropic API SDK 1.3.0 release](https://github.com/anthropics/anthropic-sdk-typescript/releases/tag/sdk-v1.3.0).

- Agent SDK `0.3.286` changed omitted `permissionMode` behavior in the presence of auto-mode settings. Cyrus now passes `permissionMode: "default"` explicitly, keeping its allow/deny lists and `canUseTool` callback authoritative. Tests cover first-party, Bedrock, Vertex, Foundry, Mantle, and telemetry-disabled configurations, including user settings that request auto mode.
- Agent SDK `0.3.293+` changed task lifecycle and MCP result envelopes. The runner tests now cover the `task_updated` → `task_notification` → `background_tasks_changed` sequence and preserve detached/omitted/error MCP result metadata.
- Agent SDK `0.3.311` requires Node 18.14 or newer; Cyrus requires Node 22.
- Agent SDK `0.3.312` adds auto-mode and unanswered-question surfaces. Cyrus does not opt into auto mode and retains its existing question callback.
- Agent SDK `0.3.314` adds sandbox-required-unavailable results and write-boundary settings. Cyrus keeps its sandbox enabled, disallows unsandboxed commands, and retains weaker network isolation; the edge-worker contract is asserted directly.
- Anthropic API SDK `1.x` changes API-key transport to Bearer authentication and defaults to API version `2026-10-21`. Hosted covers this behavior with a request-level test and explicitly disables SDK spans and trace propagation so Sentry remains the application tracing owner.

## Tool registry refresh

`./scripts/extract-claude-tools.sh` ran against the Claude Code 2.1.314 binary bundled with Agent SDK `0.3.314`. The init block exposed 30 built-in tools, exactly matching `packages/claude-runner/src/config.ts`; no built-in addition or removal was required. Nine environment-provided `mcp__agent-waymark__*` tools were also present and correctly remain outside the static built-in registry.

The core defaults already omit retired `TaskOutput`. Hosted's prior pin can still have the previous exact defaults stored, so its companion migration removes `TaskOutput` only from exact prior Linear, Slack, and GitHub arrays. Customized, reordered, empty, null, and historical arrays are left unchanged, and the migration is idempotent.

## Immutable test-release receipt

`cyrus-core@0.2.75-test.10` was published under the `test` tag; `latest` remains `0.2.73`.

- Integrity: `sha512-mOTl2ent6aA2heT90+Vm1VyoZhAEvl2/xParioy3BzeCJKEV2a3+MZl9R7+7dAbDeGul9ORI6hN5sH3ioosMhw==`
- Manifest dependency: `@anthropic-ai/claude-agent-sdk@0.3.314`
- Clean consumer resolution: `cyrus-core@0.2.75-test.10` → Agent SDK `0.3.314` → API SDK `1.3.0`
- Exported defaults: Linear 34 tools, Slack 19, GitHub 33; none contains `TaskOutput`
- Clean consumer audit: zero vulnerabilities

Only `cyrus-core` was test-published because it is the package consumed by the Hosted pin. No stable package or distribution tag was changed.

## Verification

Cyrus passed the full build and typecheck, 2,129 tests with two skipped, lint with no errors, and a zero-advisory audit. The focused runner and edge-worker compatibility suites passed.

Hosted's affected SDK, tool-default, migration, and email compatibility suites passed 14 tests, along with typecheck, lint, and a zero-advisory audit. Its full test command reported 1,450 passes and 127 skips before unrelated existing integration/mock failures. The production build reached React Email but the managed filesystem prevented its CLI from creating `~/Library/Preferences/react-email-nodejs`; direct React Email rendering and plain-text compatibility tests pass.

No authenticated model request was used as acceptance evidence for this core-only test release. The result establishes dependency identity, tool parity, permission and event contracts, migration behavior, and clean dependency resolution without changing credentials, provider configuration, runtime deployment, or stable release tags.
