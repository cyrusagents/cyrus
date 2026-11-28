# CYPACK-1660: Anthropic SDK 0.3.332 / 1.14.0 acceptance

**Date:** 2026-11-25
**Feature source:** `5a7bb7bce0c493799f96c15d5faaa97cfda9865b` ([cyrus#1624](https://github.com/cyrusagents/cyrus/pull/1624))
**Test release:** `cyrus-core@0.2.86-test.0`

## SDK and tool disposition

- `@anthropic-ai/claude-agent-sdk` is updated from 0.3.322 to 0.3.332 and `@anthropic-ai/sdk` from 1.7.0 to 1.14.0.
- **Provider aliases and defaults:** Cyrus always supplies its configured primary and fallback model (`opus` and `sonnet` by default) and passes Bedrock, Vertex, Foundry, Agent Platform, and Mantle selectors through unchanged. The Claude Code 2.1.332 Foundry/Agent Platform alias and default updates are therefore accepted provider-side resolution. Cyrus does not synthesize a Vertex region, so the new `VERTEX_REGION_CLAUDE_5_5_SONNET` behavior and the 4.5 `CLOUD_ML_REGION`/`us-east5` fallback remain operator-controlled.
- **Permission mode:** cold and pre-warmed queries explicitly use `permissionMode: "default"`; only Cyrus's explicit Automatic tool-approval setting supplies `"auto"`. The new provider-specific automatic-mode defaults cannot override either path. Cyrus has no `setPermissionMode()` caller, so its corrected return type is additive here.
- **MCP skills and skill shell hooks:** Cyrus loads user, project, and local settings plus configured MCP servers. MCP-provided `server:skill` entries and `PreSkillShellCommand` are additive SDK/plugin capabilities; tool execution still passes through the existing allowed/disallowed tool policy, and the enforced deferred-resume guard prevents unattended deferred hook calls.
- **OAuth token prefix:** Cyrus forwards the complete `CLAUDE_CODE_OAUTH_TOKEN` value without checking an `oat01-` prefix. Diagnostics and Sentry projections scrub the credential by field/entropy rather than by that prefix, so `oat02-` requires no consumer or scrubber change.
- **Mid-turn user messages:** human Linear and Slack prompts remain ordinary SDK user messages. CI continuations, issue-state updates, child results, and orchestrator feedback are Cyrus-generated relays and now set `isSynthetic: true`, including the stream-to-resume race fallback. Targeted `StreamingPrompt` and EdgeWorker tests cover both classifications.
- **API SDK 1.14:** the Google-managed data-control and compliance resources are additive. Cyrus's Hosted validation path continues to use `messages.create` and does not call those resources.
- The mandatory inventory refresh found 26 native tools plus `ListMcpResourcesTool`, `ReadMcpResourceDirTool`, and `ReadMcpResourceTool`. The final 0.3.332 increment does not change the 0.3.331 inventory, so the companion Hosted migration retains that reviewed list.

## Environment and rollout contract

- Every Claude session overwrites inherited/repository/additional values with `CLAUDE_CODE_DISABLE_DEFERRED_TOOL_RESUME=1` and `CLAUDE_CODE_DISABLE_SHELL_HEAD_START=1`; these are internal runner safety controls, not deployment-environment mutations.
- Tool extraction alone uses the isolated loopback provider, sentinel credential, isolated home/config/cache, disabled telemetry/nonessential traffic, and todo-tool flag. Operator credentials and provider selectors are excluded from that extraction environment.
- Installed-runtime provenance is scoped to immutable candidate source `c544afdd962f53d5cce8eb230b771559e886637d`, feature source `5a7bb7bce0c493799f96c15d5faaa97cfda9865b`, PR #1624 ancestry, exact publication artifacts, the clean consumer lock, the preserved `/Users/agentops` configuration, and the configured sandbox. It does not relax the sandbox or substitute an identity.

## Source F1

- Routed `DEF-1` through the real issue tracker, EdgeWorker, worktree, and ClaudeRunner query path.
- Claude Code 2.1.332 used `Read(package.json)`, then foreground `Bash(pwd)` with timeout `10000`, and returned exactly `SDK_RUNTIME_OK`.
- The activity stream coherently recorded elicitation, prompt, acknowledgment, routing, model, Read, Bash, and response events. Pagination and search returned the expected subsets.
- The session stopped and the F1 server shut down cleanly without `session_writes_lost` or an unhandled error.

## Installed configured-sandbox F1

- Registry-packed `cyrus-core@0.2.86-test.0` and `cyrus-claude-runner@0.2.86-test.0` were byte-identical to the canonical publication artifacts from Actions run 45573536723. The verifier also accepted the candidate source, feature/PR ancestry, clean consumer lock, package trees, native executable, intended account hash, and unchanged sandbox configuration.
- The actual installed `0.3.332` runtime then stopped before `Read(package.json)`: the preserved `agentops` Claude account returned `401 OAuth access token has expired. Re-authenticate to continue.` No alternate identity, provider, configuration, or sandbox was used. This does **not** satisfy the installed-runtime acceptance gate.
- The sanitized negative receipt is retained at `evidence/2026-11-25-cypack-1660-installed-sandbox-runtime-auth-blocked.json`. The prior successful 0.3.331 installed receipt at `evidence/2026-11-24-cypack-1657-installed-sandbox-runtime.json` remains unchanged.
- Required operator action: re-authenticate the same `agentops` Claude account, then rerun the candidate-aware verifier to obtain ordered `Read(package.json)` → foreground sandboxed `Bash(pwd, timeout 10000)` → exact `SDK_RUNTIME_OK`, a non-error result, no `session_writes_lost`, and a clean stop.

## Package and registry verification

- Strict install, audit, lint, build, typecheck, package tests, CLI tests, package inspection, and isolated bundle installation passed.
- The coordinated OIDC dry run passed in [Actions run 45573131952](https://github.com/cyrusagents/cyrus/actions/runs/45573131952).
- The live test-channel publication and clean installs on npm 10, 11, and 12 passed in [Actions run 45573536723](https://github.com/cyrusagents/cyrus/actions/runs/45573536723).
- Registry verification confirmed immutable `cyrus-core@0.2.86-test.0` under dist-tag `test`; stable dist-tag `latest` remains `0.2.85`.
