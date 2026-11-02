# CYPACK-1613 Anthropic SDK compatibility and runtime acceptance

**Date:** 2026-11-02. **Status: HELD — the required authenticated installed-package receipt has not passed.**

[cyrus#1575](https://github.com/cyrusagents/cyrus/pull/1575) and [cyrus-hosted#1309](https://github.com/cyrusagents/cyrus-hosted/pull/1309) remain drafts. Green CI, package mocks, option-forwarding tests, tool-name extraction, and the failed provider request are not runtime acceptance.

## Reviewed ranges and sources

- Cyrus: Agent SDK `0.3.281` → `0.3.316`; API SDK `0.128.0` → `1.3.0`.
- Hosted effective range: Agent SDK `0.3.268` → `0.3.316`; API SDK `0.125.0` → `1.3.0`.
- Bundled runtime: Claude Code `2.1.316`; installed native package `@anthropic-ai/claude-agent-sdk-darwin-arm64@0.3.316`.

The review used the official [Agent SDK history](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md), [Claude Code history](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md), and [API SDK history](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/CHANGELOG.md). The dispositions below are release-policy decisions; forwarding tests establish Cyrus configuration, not upstream provider behavior.

## Version-specific compatibility dispositions

- **Manual permissions remain explicit.** Agent SDK [`0.3.286`](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md#03286) changed an omitted permission mode, and [`0.3.302`](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md#03302) later restored `default` for affected sessions. Cyrus always passes `permissionMode: "default"`, `canUseTool`, allow/deny lists, setting sources, and sandbox settings. Tests cover that control plus caller-supplied models, fallback models, hooks, and sandbox configuration.
- **Default-on fork subagents are accepted.** Agent SDK [`0.3.302`](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md#03302) enables `subagent_type: "fork"` by default and documents `CLAUDE_CODE_FORK_SUBAGENT=0` as the opt-out. Cyrus does not inject that opt-out: forks remain available subject to the same explicit permission and sandbox policy as other tools.
- **Unknown third-party model behavior is accepted.** Claude Code [`2.1.312`](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md#21312), carried by Agent SDK [`0.3.312`](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md#03312), gives unrecognized Bedrock, Vertex, Foundry, and Mantle model names the shorter prompt and post-refusal model fallback. Cyrus preserves caller `model` and `fallbackModel` values and intentionally injects neither `CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT=0` nor `CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK=1`.
- **The signed provider model catalog is accepted.** Claude Code [`2.1.311`](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md#21311), carried by Agent SDK [`0.3.311`](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md#03311), loads a signed catalog from `downloads.claude.ai` for Bedrock, Mantle, Vertex, and Foundry and documents `CLAUDE_CODE_MODEL_CATALOG=off` as the opt-out. The review shorthand called this `.310`; the official history places it in `2.1.311`. Cyrus does not disable the signed catalog or bypass deployment egress policy.
- **Upstream hook concurrency is accepted.** Claude Code [`2.1.312`](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md#21312) caps prompt and agent hooks at 24 running callbacks per session, including subagents, plus 12 callbacks waiting beyond their declared timeout; sub-second timeouts count as one second. Cyrus forwards caller hooks unchanged and appends its Stop lifecycle recorder. It does not raise or disable the upstream ceiling.
- **Upstream compaction precedence is accepted.** Agent SDK [`0.3.296`](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md#03296) exposes per-agent `autoCompactWindow`; Claude Code [`2.1.312`](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md#21312) lets it lower, but never raise, `CLAUDE_CODE_AUTO_COMPACT_WINDOW`. Cyrus injects neither a global window nor programmatic agent definitions, so caller settings keep upstream lower-only precedence.
- **Hosted API and telemetry controls remain explicit across the wider API range.** API SDK [`0.134.0`](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/CHANGELOG.md#01340-2026-10-14) adds native OpenTelemetry, and [`1.0.0`](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/CHANGELOG.md#100-2026-10-21) changes the default API version. Hosted's request tests cover the 1.x Bearer/API-version contract and pass `openTelemetry: false`, retaining Sentry as the application tracing owner.

No additional opt-outs are introduced: the accepted upstream defaults do not conflict with Cyrus permission, sandbox, model-selection, or tracing ownership. The existing tests verify those host controls; the authenticated receipt below remains the provider-behavior gate.

## Prepared installed-package provenance

The clean consumer prepared for CYPACK-1613 from reviewed heads `cyrus@b0289765c90848d7ef020b264754a0e91f2b9101` and `cyrus-hosted@635170b68` resolves the packages below. The runner tarball was packed with the published core prerelease version so its `workspace:*` dependency resolves to the exact replacement artifact.

| Package | Version | Integrity |
| --- | --- | --- |
| `cyrus-claude-runner` | `0.2.74` | `sha512-u9rjm6VJjqyKPm5o4AZht0eSEtmjJsFOc+hIteIuwyPTI8WPJIv9jzWo2S1pe23pXdDxgSHm8QRUDN7aiE4vJw==` |
| `cyrus-core` | `0.2.75-test.13` | `sha512-/u4v6o3xBtJAGqWxW+0iDPiaH5GMV2khkptiuWUbNGRuvP7SVsmf8cCchb96ussk7R/rVQSR8iJbHaDrPoUvQA==` |
| `@anthropic-ai/claude-agent-sdk` | `0.3.316` | `sha512-mCMr0que5kIy80JslJub6WFDB2+GYRGWNeVgSZaBpkBwXrr4wnRMnnGHitkA2BEJ5QP5xWyc6YH/6do/edxCWg==` |
| `@anthropic-ai/sdk` | `1.3.0` | `sha512-k7z9BlLLPxfZH+ov7dS6EnaN/wiZeV8YNT1LZfrpAHIy7oY7pHr4UzirF9f2OlHtFEnRBOX+AZQ91Y5fK+TPTw==` |
| `@anthropic-ai/claude-agent-sdk-darwin-arm64` | `0.3.316` | `sha512-1I1oJ/YGqq4pFQvJqycD2e8pbsUQLLR+DwEzG9jQAGCoSKkxP1TBfHpjSik/0byCixyzpYObrYXPC0PKBIR91g==` |

Runner tarball SHA-256: `627bb73ddfb4058fd912c6e5fa6fc478fd885c2565fec84165c9a0de70dd6c3b`. Consumer lock SHA-256: `cea40b81fbe98373e8c66dc0aba0250d90d3d06d06bcf7ba41ff84027ee59d1a`. The installed permission contract passes in all six supported provider/telemetry configurations.

## Current identity diagnosis and required receipt

At `2026-11-02T07:34:36Z`, supported `auth status` from the CYPACK-1613 consumer's exact bundled 2.1.316 binary, run as OS user `agentops` from the consumer directory, reported the intended `connor@ceedar.io` account, `claude.ai` auth, first-party provider, organization `685559cd-fcf8-43cb-8a0e-eb20cd18cead`, Max subscription, and config directory `/Users/agentops/.claude`. This confirms the stored login record but not live token freshness. The latest bounded provider attempt remains the `2026-11-01T07:47Z` `401 OAuth access token has expired`, before either tool. No later successful receipt was found in CYPACK-1610, CYPACK-1613, or either current replacement PR.

The interactive PATH binary is an older 2.1.280 build and must not be used. The exact supported same-store action is:

`/private/tmp/cypack-1613-runner.GY6Eyd/consumer/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude auth login --claudeai --email connor@ceedar.io`

Read-only inspection confirmed that executable is the consumer-resolved `@anthropic-ai/claude-agent-sdk-darwin-arm64@0.3.316` binary (SHA-256 `64c327e92b2c5e0f78c0a980c5a518121e1f0d140ca771ca5dd4488d1a2dcb3f`) and that its help supports both flags. No `CLAUDE_CONFIG_DIR`, secure-storage override, Claude auth variable, endpoint override, or provider selector is active; user, consumer, and managed settings add no such override. It therefore uses the same default `agentops` configuration namespace as the installed runner. Per Anthropic's [credential-management documentation](https://code.claude.com/docs/en/authentication#credential-management), macOS uses Keychain primarily and a mode-0600 `.credentials.json` fallback; metadata-only inspection found that fallback at `/Users/agentops/.claude/.credentials.json`, without reading it. This evidence establishes the shared default store namespace without claiming whether Keychain or the fallback supplied the active token.

The `--email` flag pre-populates rather than enforces the browser identity. The human must complete the flow as `connor@ceedar.io`; before any provider request, the same absolute binary's read-only `auth status` must reconfirm `agentops`, `firstParty`, `claude.ai`, `connor@ceedar.io`, and organization `685559cd-fcf8-43cb-8a0e-eb20cd18cead`. No alternate account, API key, blind retry, or runtime restart is permitted. After that confirmation, one bounded run of `scripts/verify-runner-runtime.mjs` must prove, in order:

1. real installed-package `Read(package.json)` with a successful tool result;
2. foreground `Bash(pwd)` with timeout exactly `10000` and a successful tool result;
3. exact final text `SDK_RUNTIME_OK`;
4. a non-error terminal success result, completion callback, no pending work, inactive runner, and clean stop.

Until that receipt exists, both replacement PRs remain drafts and CYPACK-1613 remains In Progress. No event publication or second owner is part of this acceptance path.
