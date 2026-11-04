# CYPACK-1621 Anthropic SDK compatibility and runtime acceptance

**Date:** 2026-11-04. **Status: HELD — implementation verification is complete; npm publication and authenticated runtime acceptance require restored operator credentials.**

The replacement Cyrus pull request is intentionally a draft until the matching `cyrus-core` test package is published and Hosted is pinned to it. Green unit tests, option-forwarding mocks, generated tool extraction, and a stored Claude login do not substitute for those external gates.

## Reviewed ranges and official sources

- Cyrus: Agent SDK `0.3.281` → `0.3.318`; API SDK `0.128.0` → `1.4.0`.
- Hosted effective range: Agent SDK `0.3.268` → `0.3.318`; API SDK `0.125.0` → `1.4.0`.
- Bundled runtime: Claude Code `2.1.318`; native package `@anthropic-ai/claude-agent-sdk-darwin-arm64@0.3.318`.

The review used the official [Agent SDK history](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md), [Claude Code history](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md), and [API SDK history](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/CHANGELOG.md).

## Compatibility dispositions

- **Manual permissions remain explicit.** `ClaudeRunner` now always passes `permissionMode: "default"` alongside Cyrus's configured allow/deny lists and `canUseTool` callback. The installed-package contract covers first-party, Bedrock, Vertex, Foundry, Mantle, and telemetry-disabled configurations.
- **Default-on fork subagents are accepted.** Cyrus does not inject `CLAUDE_CODE_FORK_SUBAGENT=0`; forks inherit the parent session's tools, permissions, hooks, settings, and sandbox.
- **Unknown-provider model behavior and the signed provider catalog are accepted.** Cyrus preserves `model` and `fallbackModel`, adds no provider fallback opt-outs, and leaves catalog reachability to the host's outer network policy.
- **Upstream hook concurrency and compaction precedence are accepted.** Cyrus forwards caller hooks and adds its lifecycle/guardrail hooks without changing upstream concurrency or compaction limits.
- **Unexpected hook failures remain warn-and-continue.** Cyrus does not set the Agent SDK's optional `onFailure: "block"`; intentional policy blocks still return an explicit block decision.
- **Post-result write loss invalidates acceptance.** The runtime verifier rejects `session_writes_lost`, even if a final result was already emitted.
- **The removed `file_unchanged` Read output is unused.** Cyrus has no branch for it, and the live receipt requires an ordinary successful `Read(package.json)` result.
- **Settings and sandbox changes retain Cyrus's explicit policy.** All three settings sources remain enabled, while the EdgeWorker supplies the worktree, approved writable roots, filesystem restrictions, proxy ports, and `allowUnsandboxedCommands: false` when its sandbox is active.
- **Hosted preserves its API client contract across SDK 1.x.** It supplies exactly one API-key credential, uses Bearer authentication and API version `2026-10-21`, and disables SDK-native OpenTelemetry traces and propagation so Sentry remains the application tracing owner.
- **API SDK 1.4 additions do not expand Hosted call paths.** Hosted uses the SDK only for its Messages validation request and does not call the new analytics, spend-limit, or RBAC surfaces.

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

The clean consumer was assembled under `/private/tmp/cypack-1621-runtime-fixture` from the current branch. It is deliberately temporary and contains no retained credentials.

## External gates still held

### npm test publication

- Intended artifact: core only, `cyrus-core@0.2.76-test.0`, dist-tag `test`.
- Stable registry state before the attempt: `latest=0.2.75`; existing `test=0.2.75-test.13`.
- `packages/core/package.json` has no dependency on `cyrus-claude-runner`, so no runner prerelease is required.
- `npm whoami` returns `E401 Unauthorized`; no package, dist-tag, npm configuration, or authentication identity was changed.

The publication must use the existing authorized npm owner. After it succeeds, Hosted must pin the exact prerelease, regenerate `bun.lock`, rerun its checks, and open the companion PR.

### Authenticated installed-package receipt

The exact `0.3.318` installed runtime reached the provider but returned `401 OAuth access token has expired` before either required tool ran. No login, credential read, account/provider change, or retry under another identity was performed.

After the same operator deliberately restores Claude authentication, `scripts/verify-runner-runtime.mjs` must produce, in order:

1. a successful installed-package `Read(package.json)` result;
2. a successful foreground `Bash(pwd)` result with timeout exactly `10000`;
3. exact final text `SDK_RUNTIME_OK` after both results;
4. no `session_writes_lost` system message;
5. a non-error terminal result, completion callback, no pending work, inactive runner, and clean stop.

Until the npm prerelease, Hosted pin, and authenticated receipt exist, the Cyrus PR remains draft. No event publication, auth mutation, runtime restart, alternate account, or second owner is part of this work.
