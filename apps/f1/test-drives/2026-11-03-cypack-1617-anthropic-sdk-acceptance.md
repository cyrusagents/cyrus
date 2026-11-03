# CYPACK-1617 Anthropic SDK compatibility and runtime acceptance

**Date:** 2026-11-03. **Status: HELD — publication and authenticated runtime acceptance are separate incomplete gates.**

[cyrus#1578](https://github.com/cyrusagents/cyrus/pull/1578) remains a draft. The Hosted preparation branch is pushed at `cyrus-hosted@bf5d99c1e`, but no Hosted PR is open until the matching core test package exists. Green CI, option-forwarding mocks, tool-name extraction, and a stored login record are not authenticated runtime acceptance.

## Reviewed ranges and official sources

- Cyrus: Agent SDK `0.3.281` → `0.3.317`; API SDK `0.128.0` → `1.4.0`.
- Hosted effective range: Agent SDK `0.3.268` → `0.3.317`; API SDK `0.125.0` → `1.4.0`.
- Bundled runtime: Claude Code `2.1.317`; installed native package `@anthropic-ai/claude-agent-sdk-darwin-arm64@0.3.317`.

The review used the official [Agent SDK history](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md), [Claude Code history](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md), and [API SDK history](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/CHANGELOG.md). The dispositions below describe Cyrus policy and actual call paths. Passing mocks establish the options Cyrus sends; they do not establish upstream provider behavior, network reachability, or authenticated tool execution. No regression is claimed without an observed failure.

## Version-specific compatibility dispositions

- **Manual permissions remain explicit.** Agent SDK [`0.3.286`](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md#03286) changed an omitted permission mode, and [`0.3.302`](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md#03302) later restored `default` for affected sessions. `packages/claude-runner/src/ClaudeRunner.ts` always passes `permissionMode: "default"`, the configured allow/deny lists, and `canUseTool` when Cyrus has an AskUserQuestion handler. `packages/claude-runner/test/permission-mode.test.ts` proves this host configuration for first-party, Bedrock, Vertex, Foundry, Mantle, and telemetry-disabled inputs; authenticated acceptance remains separate.
- **Default-on fork subagents are accepted.** Agent SDK `0.3.302` enables `subagent_type: "fork"` by default and documents `CLAUDE_CODE_FORK_SUBAGENT=0` as the opt-out. Cyrus does not inject that opt-out. Forks remain subject to the tools, permissions, hooks, settings, and sandbox the parent SDK session receives.
- **Unknown-provider model behavior is accepted.** Claude Code [`2.1.312`](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md#21312), carried by Agent SDK `0.3.312`, gives unrecognized Bedrock, Vertex, Foundry, and Mantle model names the shorter prompt and post-refusal fallback. `ClaudeRunner` preserves the caller's `model` and `fallbackModel` and injects neither `CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT=0` nor `CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK=1`; custom deployment names therefore retain upstream behavior.
- **The signed provider model catalog is accepted, with its network boundary stated precisely.** Claude Code [`2.1.311`](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md#21311) loads a signed catalog from `downloads.claude.ai` for Bedrock, Mantle, Vertex, and Foundry and documents `CLAUDE_CODE_MODEL_CATALOG=off` as the opt-out. Cyrus does not set that opt-out. `packages/edge-worker/src/EgressProxy.ts` explicitly governs Bash-spawned subprocess traffic, not Claude's own background/inference traffic, and `downloads.claude.ai` is not in `packages/core/src/trusted-domains.ts`. Catalog reachability is therefore determined by the host's outer network policy, not by Cyrus's Bash egress allowlist; Cyrus provides no catalog fallback.
- **Upstream hook concurrency and compaction precedence are accepted.** Claude Code `2.1.312` caps prompt/agent hooks at 24 running callbacks per session plus 12 timed-out waiters, and lets a subagent's `autoCompactWindow` lower but never raise `CLAUDE_CODE_AUTO_COMPACT_WINDOW`. Cyrus forwards caller hooks, appends its Stop lifecycle recorder, and adds EdgeWorker PostToolUse/Stop guardrails. It does not change the upstream ceiling, inject a compaction window, or send programmatic agent definitions.
- **Agent SDK 0.3.317 hook-failure policy is deliberately not enabled.** The new matcher `onFailure: "block"` can convert a throwing or invalid hook callback into an action block, and failed callbacks now emit a stream warning. Cyrus leaves `onFailure` unset on its screenshot, PR-marker, intent-to-add, shipping guardrail, and pending-work recorder matchers, preserving the previous warn/continue behavior for callback failures. Intentional guardrail blocks still use a returned `{ decision: "block" }` in `packages/edge-worker/src/RunnerConfigBuilder.ts`; Cyrus does not turn every unexpected callback exception into a new blocking policy.
- **Post-result session write loss invalidates the acceptance receipt.** Agent SDK `0.3.317` adds the `session_writes_lost` system message after the final result when a full disk or quota prevents transcript or global-config persistence; Claude Code `2.1.317` also exits `claude -p` with status 1 for the corresponding loss. `ClaudeRunner` continues to retain and emit system messages until the SDK iterator ends and does not rewrite an already received result. For this upgrade's stronger gate, `scripts/verify-runner-runtime-receipt.mjs` now rejects any `session_writes_lost` message, so a superficially successful result cannot produce a durable PASS.
- **The removed repeated-Read variant is unused.** Agent SDK `0.3.317` removes the `file_unchanged` arm of `FileReadOutput`; repeated reads now return content. Cyrus has no `FileReadOutput` or `file_unchanged` branch. The installed runtime receipt matches ordinary tool-use/tool-result envelopes and requires a successful real `Read(package.json)`, so it neither depends on nor synthesizes the removed variant.
- **Nested session IDs remain enabled upstream.** Claude Code `2.1.317` adds `CLAUDE_CODE_DISABLE_NESTED_SESSION_ID=1` for self-hosted runners that need the earlier shared-ID behavior. Cyrus does not set it and does not itself launch nested `claude -p` processes. `ClaudeRunner` records the first top-level `session_id` for resume, while `AgentSessionManager` retains each SDK message's `session_id` and `parent_tool_use_id` for activity lineage. A customer-invoked nested CLI inside Bash remains the subprocess's own transcript/output; Cyrus adds no compatibility remapping.
- **Account-email network approval is not claimed as a Cyrus human prompt.** Claude Code `2.1.317` asks before a web or shell tool sends the signed-in account email to the network. Cyrus's generic non-AskUserQuestion branch in `ClaudeRunner.createCanUseToolCallback()` returns `allow`, because its interactive bridge only presents the `AskUserQuestion` tool; ordinary tool permission prompts are governed by Cyrus allow/deny rules and, for Bash subprocesses when enabled, EdgeWorker's egress policy. The new upstream ask may therefore be host-approved rather than shown to a human. This review does not claim otherwise and introduces no new UI or network permission model.
- **Settings-source and sandbox changes use Cyrus's existing explicit paths.** Agent SDK `0.3.314` fixed excluded setting sources still supplying auto-mode rules/consents and added `permissions.blockWritesOutsideWorkingDirectories`; `0.3.316` added `permissions.blockReadsExemptPaths`. Cyrus passes `settingSources: ["user", "project", "local"]`, so it intentionally includes all three rather than relying on an exclusion. When the EdgeWorker sandbox is enabled, `RunnerConfigBuilder.buildSandboxConfig()` supplies `allowUnsandboxedCommands: false`, filesystem allow/deny paths, proxy ports, and the worktree/approved writable roots. Cyrus does not populate the two new settings keys; its own SDK sandbox object and tool-pattern restrictions remain authoritative. The `sandbox_required_unavailable`/`initialize_not_first` startup classifications are SDK failures surfaced through the existing runner error path, not retried blindly.
- **Hosted retains the API 1.x version/authentication and tracing decisions across the wider range.** API SDK [`0.134.0`](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/CHANGELOG.md#01340-2026-10-14) adds native OpenTelemetry, and [`1.0.0`](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/CHANGELOG.md#100-2026-10-21) changes the default API version. `apps/app/src/lib/anthropic-api-client.ts` supplies exactly one explicit API-key credential and disables SDK traces and propagation so Sentry remains the application tracing owner. Its tests require Bearer auth, no `x-api-key`, API version `2026-10-21`, and no trace headers even when telemetry environment variables and a global tracer are present.
- **API SDK 1.4 additions are non-call-path type expansion.** Version [`1.4.0`](https://github.com/anthropics/anthropic-sdk-typescript/releases/tag/sdk-v1.4.0) adds GA analytics/spend-limit/RBAC methods, required analytics fields, and `tool_use_limit_reached_error` / `compaction_limit_reached_error` session error types. Hosted's SDK client is used only for the Messages validation call; it does not call the new admin/analytics surfaces or exhaustively switch on those session error unions. Existing HTTP-status and server-message handling therefore remains applicable without a new runtime branch.

The mandatory extraction against the 0.3.317 package found the same 30 built-in tools. The Hosted migration removes retired `TaskOutput` only from stored lists that exactly equal the previous defaults; customized, reordered, empty, null, and historical lists remain untouched.

## Retained current-source package fixture

The fixture is retained at:

`/Users/agentops/.cyrus/CYPACK-1617/attachments/retained-runtime-fixture`

It was packed from `cyrus@a03be10d087979379342ed6efb4b8846d7fcfe9a` and installed into a clean consumer with lifecycle scripts disabled. The later evidence-only commit changes the verifier, tests, and this report, not the packed runner implementation.

| Package | Version | Lock integrity |
| --- | --- | --- |
| `cyrus-claude-runner` | `0.2.74` | `sha512-4HkUodfp0LstWB3WXVTcdpmJd2dpSV1U20NTIpXkHeCkE4KamzcSwGOwx1xfRSufPEbiSY9QcbFusmGu3570JQ==` |
| `cyrus-core` | `0.2.74` | `sha512-CgipyWNmNUsWdj3QtPw/Fwyndvu2bKurr+FE++mW0SndI1Ev2qLb/ovN5DNa93wXLUuDryUIDN1yU0HIQLJO3A==` |
| `@anthropic-ai/claude-agent-sdk` | `0.3.317` | `sha512-qoRB5svuBNXm5N5miBj3RS2JyA7daGcdOCopQIdJXMxaYREIvR7P1FFiFhSLwIjh61D9ir8f/8OFm5LyDJspEA==` |
| `@anthropic-ai/sdk` | `1.4.0` | `sha512-tyuibnhQL57kLOx5oomY4Ld7jOVOPNC5v3IiyRtR3l+Friv66tI4VbuZYF2NMel/T0WMuQMBFOMKDBUbUh8gPA==` |
| `@anthropic-ai/claude-agent-sdk-darwin-arm64` | `0.3.317` | `sha512-SSXvZ04MpfA0hLfGrP9SBTNOgw2p2TsmJAUjr6GA5bM9LVLRLX6pmiIAaTtpaPhslK+zd6Nf5taU/XRldPyUBg==` |

Runner tarball SHA-256: `0bc1cc79386f12d12a514e08a813f632d034d9fc2f64a12e805cf1eb80b773a8`. Core tarball SHA-256: `c9bdca270bcc99938a9ddc0401a0392e5d13815b4b0ed2533f69a2d50ab65669`. Consumer lock SHA-256: `2581fc415081d96cff1f37b7def22050d706e6839313fd26b26d46cd373f5c6d`. Native executable SHA-256: `09f153b46b5df9e8b3454716d682a91901de020cbca630f61dec1a015b32b5e9`.

The installed-package permission contract passes in all seven first-party/provider/telemetry configurations, including Mantle. That check uses an SDK module mock and establishes only the packaged query options; it is not the authenticated receipt below.

## Exact runtime executable, store, and account

Consumer-relative resolution selects this exact executable, not the unrelated PATH Claude installation:

`/Users/agentops/.cyrus/CYPACK-1617/attachments/retained-runtime-fixture/consumer/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`

Read-only evidence from that absolute path on 2026-11-03:

- OS user: `agentops`.
- `--version`: `2.1.317 (Claude Code)`.
- SDK/native package: `@anthropic-ai/claude-agent-sdk-darwin-arm64@0.3.317`.
- Config store: `/Users/agentops/.claude`; projects store: `/Users/agentops/.claude/projects`.
- `auth status`: stored login present; method `claude.ai`; provider `firstParty`; email `connor@ceedar.io`; organization `685559cd-fcf8-43cb-8a0e-eb20cd18cead`; Max subscription.
- `CLAUDE_CONFIG_DIR`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, and `CLAUDE_CODE_OAUTH_TOKEN` were absent from the inspecting process.

No login, credential read, auth/provider change, provider request, or runtime restart was performed. `auth status` establishes the stored identity and namespace, not token freshness. The last bounded provider attempt remains the earlier `401 OAuth access token has expired`, before either required tool; it was not retried.

## Exact npm publication context

- OS user: `agentops`.
- Working directory: `/Users/agentops/.cyrus/worktrees/CYPACK-1617/cyrus/packages/core`.
- npm executable: `/usr/local/bin/npm` → `/usr/local/lib/node_modules/npm/bin/npm-cli.js`, npm `10.9.2`, Node `/usr/local/bin/node` `v22.17.1`.
- Registry: `https://registry.npmjs.org/`.
- Project config: `/Users/agentops/.cyrus/worktrees/CYPACK-1617/cyrus/.npmrc` (pnpm hoist rules only).
- User config: `/Users/agentops/.npmrc`; global config: `/Users/agentops/.npm-global/etc/npmrc`; prefix: `/Users/agentops/.npm-global`. Credential values are intentionally omitted.
- Effective `npm whoami`: `E401 Unauthorized`.
- Intended publishing identity: the registry lists the sole `cyrus-core` maintainer as `connorturland <connor@ceedar.ai>`.
- Intended artifact: core only, next unused `cyrus-core@0.2.75-test.14`, published under dist-tag `test`. `packages/core/package.json` does not depend on `cyrus-claude-runner`, so no runner publication is required.
- Registry state remains unchanged: `latest=0.2.73`, `test=0.2.75-test.13`.

No npm authentication, config, package version, dist-tag, or publication was changed. A main operator must choose the precise same-owner recovery; this report does not direct an interactive login or switch identities.

## Required authenticated runtime receipt

After same-owner authentication is deliberately restored, the clean consumer must be regenerated from the then-current reviewed source and exact published core prerelease. `scripts/verify-runner-runtime.mjs` must run once against that installed runner and produce all of the following in order:

1. real installed-package `Read(package.json)` with a successful tool result;
2. foreground `Bash(pwd)` with timeout exactly `10000` and a successful tool result;
3. exact final text `SDK_RUNTIME_OK` after both results;
4. no `session_writes_lost` system message;
5. a non-error terminal success result, completion callback, no pending work, inactive runner, and clean stop.

Until both the core-only test publication and that authenticated installed-package receipt exist, the Cyrus PR stays draft, no Hosted pin PR is opened, and CYPACK-1617 stays In Progress. No event publication, auth mutation, runtime restart, alternate account, or second owner is part of this evidence update.
