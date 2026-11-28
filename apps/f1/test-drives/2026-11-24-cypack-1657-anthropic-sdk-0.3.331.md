# CYPACK-1657: Anthropic SDK 0.3.331 runtime verification

**Date:** 2026-11-24

**Goal:** Verify that Cyrus runs Claude Agent SDK 0.3.331 / Claude Code 2.1.331 through its issue, worktree, tool, and activity pipeline.

**Test repository:** `/private/tmp/f1-cypack-1657-final.v8n6r4/repo`

**Tested source:** `bf9751f936100dfd837ba68cffc9db463c9ac53d`

## Scenario

F1 created a disposable repository and routed an inspection-only issue through the real `ClaudeRunner` query path. The prompt required `Read(package.json)`, a foreground `Bash(pwd)` call with timeout `10000`, and the exact final marker `SDK_RUNTIME_OK`, without modifying files.

## Verification results

### Issue tracker

- [x] Health and ready status returned successfully.
- [x] `issue-1` / `DEF-1` was created and exposed through the CLI tracker.
- [x] Repository selection accepted `F1 Test Repository` and resumed the pending session.

### EdgeWorker and Claude runtime

- [x] Installed packages resolved to `@anthropic-ai/claude-agent-sdk` 0.3.331 and `@anthropic-ai/sdk` 1.13.0.
- [x] The bundled native executable reported Claude Code 2.1.331.
- [x] EdgeWorker created the `DEF-1` worktree from local `main`.
- [x] Cyrus supplied its 33-tool engineering catalog, including the three MCP resource-discovery tools.
- [x] Claude read `package.json`, ran foreground `Bash(pwd)`, and returned exactly `SDK_RUNTIME_OK`.
- [x] The session completed successfully without `session_writes_lost` or an unhandled error.

### Activity rendering

- [x] Elicitation, prompt, acknowledgment, routing, model, action, and response activities rendered coherently.
- [x] Pagination returned the requested three-activity window.
- [x] Search returned the Claude model activity.
- [x] The stop request completed the session and the F1 server shut down cleanly.

## Sanitized evidence

[The retained source-runtime receipt](evidence/2026-11-24-cypack-1657-source-runtime.json) records only the version, source, tool/result, lifecycle, and limitation fields needed for review. It excludes account identifiers, credentials, environment values, and raw query options.

[The installed configured-sandbox receipt](evidence/2026-11-24-cypack-1657-installed-sandbox-runtime.json) binds the immutable npm candidate, feature source, exact PR head, consumer lock, packed and installed trees, native executable, intended identity digest, and preserved sandbox configuration. It excludes the account identifier, credentials, raw environment values, prompts, and tool output.

## Supporting checks

- `./scripts/extract-claude-tools.sh` completed against Claude Code 2.1.331 with 26 native tools and three resource-capability additions: `ListMcpResourcesTool`, `ReadMcpResourceDirTool`, and `ReadMcpResourceTool`.
- The extracted catalog is unchanged from 2.1.330. Cyrus intentionally retains four context-dependent capabilities beyond the 29-tool fixture: `PushNotification`, `LSP`, `RemoteTrigger`, and `DesignSync`.
- The monorepo build and typecheck passed.
- Focused Claude runner, core, and EdgeWorker compatibility suites passed: 381 tests.

## Claude Code 2.1.331 dispositions

| Upstream behavior | Cyrus disposition |
| --- | --- |
| Edit and Write results now report text changed through `canUseTool.updatedInput`. | Accepted as an upstream result-correctness fix. Cyrus preserves the SDK result and does not reconstruct permission-time edits independently. |
| Browser SDK event streams now honor `Retry-After` and retain queued notices. | Accepted as an upstream transport fix. Cyrus does not replace or weaken the SDK retry timing. |
| `listSessions()` without a limit no longer opens every transcript concurrently. | Accepted as an upstream resource-safety fix. Cyrus does not impose a conflicting transcript scan. |
| `rewindFiles()` refuses when managed settings disable checkpointing and no longer deletes files after a failed restore. | Accepted as an upstream managed-policy and data-safety boundary. Cyrus does not bypass the refusal or add cleanup after a failed restore. |
| Foreground and background subagent task notifications consistently name their output file. | Accepted as an upstream event-shape correction. Cyrus treats the field as runtime-provided metadata. |
| Agent SDK 0.3.331 remains on the same 26 native plus three MCP-resource tool registry as 0.3.330. | The carried-forward static catalog remains current; no additional default-list or migration change is needed for the .331 increment. |

## Effective 0.3.322 → 0.3.331 behavior dispositions

The full [Agent SDK range](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md#03331) and the bundled [Claude Code 2.1.331 release](https://github.com/anthropics/claude-code/releases/tag/v2.1.331) were reviewed against Cyrus’s actual SDK query path:

| Upstream behavior | Effective Cyrus disposition |
| --- | --- |
| Managed `disableSideloadFlags` can refuse startup with `startup_failure_reason: "sideload_flags_disabled"`. | **Preserved refusal.** Cyrus neither supplies host `managedSettings` nor adds a fallback that weakens machine policy. If externally managed policy conflicts with Cyrus-supplied plugin or MCP launch options, the SDK error result and exact startup reason remain in the runner message stream. A contract test now fixes this disposition. |
| In a future release on or after 2026-11-30, managed `extraKnownMarketplaces` entries auto-update unless their entry sets `autoUpdate: false`. | **Managed upstream path; no Cyrus override.** Cyrus does not author `extraKnownMarketplaces`, toggle `autoUpdate`, or run a marketplace updater. The future behavior can affect only an operator-managed entry loaded by Claude Code; operators who require a frozen marketplace must set `autoUpdate: false` in that managed entry. |
| Claude Code 2.1.331 adds terminal Code Mode on Bedrock, Google Cloud Agent Platform, Foundry, and Claude Platform on AWS; 2.1.329 also permits Code Mode with OTel events/metrics, while tracing still disables it. | **Unsupported in this SDK query path.** Cyrus does not enable Code Mode or claim its terminal-only behavior. It continues to expose the direct SDK tool list with Cyrus allow/deny rules and hooks. The installed acceptance therefore proves direct `Read` and `Bash`, not Code Mode. |
| Third-party provider and permission defaults changed across the range. | **Explicitly unchanged by Cyrus.** Bedrock, Vertex, Foundry, and Mantle selection variables pass through without provider substitution; custom primary/fallback models and hooks remain intact. Cyrus fixes allowlist sessions to `permissionMode: "default"` across those providers and enables automatic review only for explicit `toolApprovalMode: "auto"`. |
| `CLAUDE_CODE_DISABLE_RESPONSE_COMPRESSION` can request uncompressed model responses when a proxy truncates compressed responses; upstream does not yet advise it for self-hosted runners or Remote Control. | **Unchanged compressed default.** Cyrus does not inject or rewrite this variable. An operator-provided value passes through unchanged. EgressProxy forwards response headers and pipes response bytes without decompression or recompression, so the default compressed transport remains transparent. |
| Code Mode and MCP/schema behavior now works in more third-party or telemetry-disabled cases, and OTel spans gained `gen_ai.*` fields. | **Upstream-owned telemetry behavior.** Cyrus does not force telemetry on, remove `DISABLE_TELEMETRY`/`DO_NOT_TRACK`, or consume the new span fields. Those environment settings pass through, while Cyrus’s permission, sandbox, hook, and direct-tool configuration remains the same. |

## Installed candidate and configured-sandbox gate

The earlier source-worktree drive intentionally did not enable the SDK sandbox or install from npm. The retained negative nested-sandbox receipt remains evidence of that limitation; it has not been rewritten or relaxed.

The follow-up installed-runtime gate passed against the immutable `0.2.84-test.1` registry candidate from source `5df4e9c5c4b54edb053922a0434439bc6eb8ea0a`, carrying feature source `d5f2c7edf0e2a2a0f5e0ac0d8a466c05b9ad8765`, and current PR head `bf37d37e7d092c598a5033c43173c6a621e174fe`:

- [x] Registry core and runner tarballs byte-matched the release artifact bundle and their installed trees.
- [x] Both installed packages carried the exact `cyrusTestRelease` source stamp.
- [x] The consumer lock, Claude Code 2.1.331 native executable, intended first-party identity digest, and configuration contract matched provenance.
- [x] The SDK sandbox was enabled with `allowUnsandboxedCommands: false`; no generic login, identity substitution, provider override, or sandbox relaxation was used.
- [x] A sequencing hook blocked one premature parallel Bash attempt. After the successful `Read(package.json)` result, foreground sandboxed `Bash(pwd)` ran with timeout `10000` and returned successfully.
- [x] The final text was exactly `SDK_RUNTIME_OK`; the result was non-error, no `session_writes_lost` event occurred, no pending work remained, and the runner stopped cleanly.

The remaining cross-repository gate is Hosted’s isolated migration/default-preservation acceptance and an owner-supported exact-head app-CI signal while its app workflows remain disabled.
