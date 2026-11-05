# CYPACK-1623 Anthropic SDK compatibility and runtime acceptance

**Date:** 2026-11-05. **Status: IN PROGRESS — implementation verification is complete; npm publication, Hosted pinning, and final installed-package checks are pending.**

[cyrus#1583](https://github.com/cyrusagents/cyrus/pull/1583) supersedes closed predecessor #1580 and remains a draft until the matching `cyrus-core` test package is published and Hosted is pinned to it. Green unit tests, option-forwarding mocks, generated tool extraction, and a stored Claude login do not substitute for those external gates.

## Reviewed ranges and official sources

- Cyrus: Agent SDK `0.3.281` → `0.3.318`; API SDK `0.128.0` → `1.5.0`.
- Hosted effective range: Agent SDK `0.3.268` → `0.3.318`; API SDK `0.125.0` → `1.5.0`.
- Bundled runtime: Claude Code `2.1.318`; native package `@anthropic-ai/claude-agent-sdk-darwin-arm64@0.3.318`.

The review used the official [Agent SDK history](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md), [Claude Code history](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md), and [API SDK history](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/CHANGELOG.md).

An [independent exact-head review](https://github.com/cyrusagents/cyrus/pull/1583#pullrequestreview-5787999783) of `c8564ebd302853b1b0336ed88a31d32c414363b4` identified that opt-in warm sessions also need the explicit manual permission mode at `startup()`, because their attached first query bypasses `ClaudeRunner.start()` option construction. The correction and focused regression below close that compatibility gap without a provider call.

## Compatibility dispositions

- **Manual permissions remain explicit.** `ClaudeRunner.start()` passes `permissionMode: "default"` on cold queries alongside Cyrus's configured allow/deny lists and `canUseTool` callback. `EdgeWorker.warmupRecentSessions()` also passes that mode explicitly to `startup()`: an attached `warmSession.query(prompt)` does not receive the cold query options. This prevents loaded `permissions.defaultMode: "auto"` or `"acceptEdits"` from selecting a different mode on either path; explicit deny rules remain a separate control. The installed-package contract covers first-party, Bedrock, Vertex, Foundry, Mantle, and telemetry-disabled configurations.
- **Default-on fork subagents are accepted.** Cyrus does not inject `CLAUDE_CODE_FORK_SUBAGENT=0`; forks inherit the parent session's tools, permissions, hooks, settings, and sandbox.
- **Unknown-provider model behavior and the signed provider catalog are accepted.** Cyrus preserves `model` and `fallbackModel`, adds no provider fallback opt-outs, and leaves catalog reachability to the host's outer network policy.
- **Upstream hook concurrency and compaction precedence are accepted.** Cyrus forwards caller hooks and adds its lifecycle/guardrail hooks without changing upstream concurrency or compaction limits.
- **Unexpected hook failures remain warn-and-continue.** Cyrus does not set the Agent SDK's optional `onFailure: "block"`; intentional policy blocks still return an explicit block decision.
- **Post-result write loss invalidates acceptance.** The runtime verifier rejects `session_writes_lost`, even if a final result was already emitted.
- **The removed `file_unchanged` Read output is unused.** Cyrus has no branch for it, and the live receipt requires an ordinary successful `Read(package.json)` result.
- **Settings and sandbox changes retain Cyrus's explicit policy.** All three settings sources remain enabled, while the EdgeWorker supplies the worktree, approved writable roots, filesystem restrictions, proxy ports, and `allowUnsandboxedCommands: false` when its sandbox is active.
- **The wider `deniedMcpServers` URL matching applies to every settings source Cyrus loads.** [Claude Code 2.1.318](https://github.com/anthropics/claude-code/releases/tag/v2.1.318) now applies a denied URL to Anthropic-provided servers with the same upstream URL and to cloud/self-hosted connectors with a supplied URL (falling back to connector name otherwise). Both `ClaudeRunner.start()` and EdgeWorker warmup load `user`, `project`, and `local` settings; the EdgeWorker-created local file only sets `includeCoAuthoredBy`. Cyrus does not rewrite `deniedMcpServers`, so an operator deny in any loaded settings source now has the wider upstream effect. `strictMcpConfig` still controls whether non-explicit MCP sources can load; it does not erase those loaded settings. This upstream security tightening is accepted.
- **Old-session resume no longer preserves pre-2.1.287 thinking.** [Claude Code 2.1.318](https://github.com/anthropics/claude-code/releases/tag/v2.1.318) removed the compatibility fix that preserved earlier thinking when resuming conversations begun on 2.1.286 or older. EdgeWorker warmup passes the persisted `session.claudeSessionId` directly to `startup()`, while normal resume selects that same stored ID and `RunnerConfigBuilder` forwards it to `ClaudeRunner`, which passes it as the SDK `resume` option. Cyrus stores and forwards the session ID but does not persist or reconstruct Claude's thinking blocks, so those old blocks may be dropped on resume. No Cyrus shim is added; visible messages and tool state remain the supported continuity boundary.
- **Hosted preserves its API client contract across SDK 1.x.** It supplies exactly one API-key credential, uses Bearer authentication and API version `2026-10-21`, and disables SDK-native OpenTelemetry traces and propagation so Sentry remains the application tracing owner.
- **API SDK 1.5 additions do not expand Hosted call paths.** Hosted uses the SDK only for its Messages validation request and does not call the new analytics, spend-limit, RBAC, workspace-filter, or error-detail surfaces.

Agent SDK `0.3.318` additionally exposes credential expiry, invalid-config startup diagnostics, queued-message/model-change interruption fixes, progress-summary waiting, and optional push-notification status while reaching Claude Code `2.1.318`. No Cyrus compatibility shim is required for those additions.

## Generated tool inventory and stored-default migration

`./scripts/extract-claude-tools.sh` ran against the exact `0.3.318` package and found 30 built-in tools plus nine project MCP tool patterns. The built-in inventory is unchanged from the immediately preceding candidate. Hosted is moving from its older effective `0.3.268` core package, so its exact-default migration removes retired `TaskOutput` only from stored Linear, Slack, and GitHub lists that byte-for-byte equal the prior runtime defaults. Customized, reordered, empty, null, and historical lists remain untouched.

## Verification completed

- `pnpm build`
- `pnpm test:packages:run`
- `pnpm typecheck`
- `pnpm lint` (passes with 14 pre-existing warnings)
- `pnpm audit --audit-level low` (zero advisories)
- mandatory Agent SDK tool extraction (30 built-ins, nine project MCP patterns)
- clean packed-consumer installation with lifecycle scripts disabled
- installed-package permission contract: PASS for all seven configurations

The clean consumer is assembled under `/private/tmp/cypack-1623-runtime-fixture-v2` from the current branch. A credential-free copy will be retained in the CYPACK-1623 attachments directory; runtime receipt/session output is excluded. Its safe provenance record contains only source/artifact digests, installed package names and versions, the native executable digest/version, and selected identity fields (`osUser`, login state, auth method, API provider, an account-email digest, and subscription type). It contains no configuration, raw email address, environment values, access tokens, or OAuth material.

The verifier recomputes and requires all of the following before it may contact the provider:

- the local commit is the live head of `cyrusagents/cyrus#1583`, with no tracked changes;
- packed runner SHA-256 `91f5ed141cd8ef2c344408fc32b94f0c7327c2d04388734e0c8bf7e460186ced` and core SHA-256 `a361bab54d3e02093155eba1a7ed569704ce9ffb22cd9626f280755183e2ef07`, plus their extracted trees matching the installed package trees;
- retained consumer lock SHA-256 `aab96b4a73ab8ceef592814246e9944b686c9be3d72991ced010055b1e2259ab`;
- `cyrus-claude-runner@0.2.75`, `cyrus-core@0.2.75`, `@anthropic-ai/claude-agent-sdk@0.3.318`, `@anthropic-ai/sdk@1.5.0`, and `@anthropic-ai/claude-agent-sdk-darwin-arm64@0.3.318`;
- Claude Code `2.1.318` and native executable SHA-256 `677a2ea7bf576cedd20e191d973914ed8a41796f53a63b1923381ddc4d5b5e7d`;
- OS user `agentops`, `claude.ai` authentication, `firstParty` provider, the SHA-256 account identifier for the existing owner, and `max` subscription, with no provider/account override environment variable.

The final-head provenance JSON is generated outside the repository after the final commit, avoiding a self-referential commit hash. `scripts/verify-runner-provenance.mjs` validates it independently without starting a provider request. The authenticated verifier additionally requires the init event to report Claude Code `2.1.318`; logging an optional runtime version is not sufficient.

## Warm-session review revision

The focused `packages/edge-worker/test/EdgeWorker.warm-session-permission-mode.test.ts` regression runs the real EdgeWorker warmup and attachment methods and `ClaudeRunner.start()`, with both SDK entry points mocked. For each project and local settings fixture (`permissions.defaultMode: "auto"` and `"acceptEdits"`), the mock reads the fixture when settings sources are supplied and the test verifies:

- `startup()` receives explicit `permissionMode: "default"`, the persisted resume ID, and the configured allow/deny lists;
- with `CYRUS_ENABLE_WARM_SESSIONS=1`, EdgeWorker consumes the stored warm instance and attaches it to the runner;
- the attached runner calls that instance's `query(prompt)` without falling through to the cold SDK query;
- a cold resumed runner separately supplies `permissionMode: "default"` and the persisted resume ID.

The two project-settings cases failed on the missing startup option before the fix and pass with it; the same matrix also covers local settings. This establishes option propagation without a provider request; it does not claim to test SDK permission enforcement or satisfy the authenticated receipt. The F1 protocol remains applicable to session continuation and activity output, but end-to-end execution remains held by the previously documented expired owner authentication. No unrelated F1 drive is substituted.

Revision checks: `pnpm build`, `pnpm typecheck`, `pnpm test:packages:run` (including the four-case settings matrix), `pnpm lint` (14 existing warnings), and `pnpm audit --audit-level low` (zero advisories). These checks must also pass on the final committed head. A fresh isolated consumer at `/private/tmp/pr1583-packed-consumer` installs freshly packed core/runner tarballs with lifecycle scripts disabled; both tarball SHA-256 values match the retained values above because this revision changes only EdgeWorker runtime code. Its seven-configuration installed permission contract passes. The existing tool inventory is unchanged; this revision does not change the SDK pins or tool lists and makes no new provider request for extraction or option propagation.

The final-head provenance JSON and check logs are retained outside the repository to avoid embedding a self-referential commit hash. That preflight verifies the installed core/runner artifacts; it does not exercise the changed EdgeWorker warmup path, which is covered by the focused regression above.

The npm owner check was repeated for this revision and still returned `E401`; registry tags remain `latest=0.2.75` and `test=0.2.75-test.13`. The exact prerelease remains unpublished, the Hosted companion remains absent, and the authenticated ordered Read → foreground Bash → SDK_RUNTIME_OK → non-error result/clean stop receipt remains missing. The PR remains draft.

## External gates still held

### npm test publication

- Intended artifact: core only, `cyrus-core@0.2.76-test.0`, dist-tag `test`.
- Stable registry state before the attempt: `latest=0.2.75`; existing `test=0.2.75-test.13`.
- `packages/core/package.json` has no dependency on `cyrus-claude-runner`, so no runner prerelease is required.
- `npm whoami` returns `E401 Unauthorized`; no package, dist-tag, npm configuration, or authentication identity was changed.

The publication must use the existing authorized npm owner. After it succeeds, Hosted must pin the exact prerelease, regenerate `bun.lock`, rerun its checks, and open the companion PR.

### Authenticated installed-package receipt

After the final source commit is pushed, `scripts/verify-runner-runtime.mjs` must first pass the exact provenance preflight above, then produce, in order:

1. a successful installed-package `Read(package.json)` result;
2. a successful foreground `Bash(pwd)` result with timeout exactly `10000`;
3. exact final text `SDK_RUNTIME_OK` after both results;
4. no `session_writes_lost` system message;
5. a non-error terminal result, completion callback, no pending work, inactive runner, and clean stop.

Until the npm prerelease, Hosted pin, and authenticated receipt exist, the Cyrus PR remains draft. No event publication, auth mutation, runtime restart, alternate account, or second owner is part of this work.
