# CYPACK-1609: required integrated runtime acceptance

**Date:** 2026-10-31. **Status: HELD — authenticated runtime acceptance is required and has not passed.**

PR [cyrus#1570](https://github.com/cyrusagents/cyrus/pull/1570) replaces [#1567](https://github.com/cyrusagents/cyrus/pull/1567), including its acceptance handoff at `ce23def6e34100f9d08189a34b6384d730ad7f5b`. The October 31 Linear summaries calling the receipt “optional” are incorrect. Green CI, permission-option mocks, core publication, init/tool-name discovery, and a provider rejection before tools do not satisfy this gate. Hosted [#1301](https://github.com/cyrusagents/cyrus-hosted/pull/1301) must not merge ahead of accepted companion runtime validation.

## Reconciliation and ranges

Merged main `898566dca9af2fe39b30882c7952746f329ac0f9` (#1569). Kept its security changelog entry, Axios `1.21.0` and follow-redirects `1.16.2`; removed the duplicate security entry from this PR. No security override was removed or weakened. The SDK bump does not replace the direct owners that require the existing overrides.

- Cyrus: Agent SDK `0.3.281` → `0.3.316`; API SDK `0.128.0` → `1.3.0`.
- Hosted effective range remains wider: Agent SDK `0.3.268` → `0.3.316`; API SDK `0.125.0` → `1.3.0`.
- Bundled Claude Code: `2.1.316`, native build `cd7ceb459c68`.
- Prior core publication `cyrus-core@0.2.75-test.11` remains the Hosted pin. This reconciliation does not publish packages or move tags.

Sources: [Agent SDK history](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md), [Claude Code history](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md), [API SDK 1.3.0](https://github.com/anthropics/anthropic-sdk-typescript/releases/tag/sdk-v1.3.0), and installed `.316` `sdk.d.ts`. The dispositions below retain the earlier exact-range review, with `.315`/`.316` additions. These are applicability/policy decisions; mocked forwarding tests do not establish provider behavior.

## Current access diagnosis — no runtime retry

The installed `.316` native CLI was checked using supported `auth status --json` and `doctor` commands, without reading credential files, changing credential/provider configuration, or restarting Cyrus.

- `auth status`: logged in through `claude.ai`, first-party provider, `connor@ceedar.io`, organization `685559cd-fcf8-43cb-8a0e-eb20cd18cead`, Max subscription. This matches the prior intended identity.
- No API-key, auth-token, OAuth-token, provider selector, base-URL, or Claude config-directory environment override is present. Only the unrelated `CLAUDE_CODE_TMPDIR` name is present among Claude variables.
- `doctor`: native `.316` runs; managed remote settings and organization policy are not applicable to this Max subscription. macOS Keychain is not writable (`User interaction is not allowed`, `-25308`); its documented consequence is failure to save a **Console API key**, not proof that the current claude.ai OAuth token is expired.
- Neither supported diagnostic reports live token validity or successful provider access. The previous rejection is historical evidence, not proof of perpetual expiry. There is no established evidence of restored access yet. No model request, extraction request, credential refresh/substitution, or runtime restart was made during this reconciliation.

The operator has been asked whether the **same identity** has re-authenticated since the failed October 31 attempt. No answer is treated as approval or restored access. If that login has not been restored, use the supported `claude auth login` flow as `agentops` on this host with `connor@ceedar.io`; do not supply a different account or an API key. The Keychain warning alone does not justify changing authentication method or claiming that unlocking it is required for OAuth. See [authentication documentation](https://code.claude.com/docs/en/authentication).

## Required installed-package gate

Build and pack runner and core from the same source revision, install both tarballs together in a fresh consumer, and retain tarball SHA-256/integrities, source revision, consumer lock hash, resolved SDK versions and native runtime hash. Run `scripts/verify-runner-runtime.mjs <installed-runner> <consumer> --provenance-only` without a model request to prepare the receipt.

Only after supported diagnosis establishes restored access for the intended identity, run the same command without `--provenance-only` once. It requires:

1. successful Read of this consumer's exact `package.json`, including its contents;
2. subsequent foreground Bash command exactly `pwd`, timeout exactly `10000`, successful result matching the consumer directory;
3. subsequent exact `SDK_RUNTIME_OK`, a non-error success result, complete callback, no pending work, inactive runner and clean stop.

The verifier now rejects error-bearing tool results, wrong files/directories, missing results, reordered/extra tools, early markers, background execution and wrong timeouts. Cleanup runs even if the request rejects. It records installed runner/core/Agent SDK/API SDK/native-runtime content hashes and consumer lock SHA-256, checks that runner/core share one SDK, and checks the intended account through that installed native binary before a request. The thirteen synthetic receipt tests run in CI; they verify the gate's rejection rules and are **not** an authenticated receipt.

## Compatibility dispositions retained through .314

- **Node floor and startup:** Agent SDK `0.3.311` raises its minimum Node version to `18.14`; Cyrus requires Node 22. Deferred background startup work begins on the first request and may take about ten seconds. Initialization alone is not provider acceptance.
- **Permissions, auto mode, and settings:** Cyrus passes explicit `permissionMode: "default"`, `canUseTool`, setting sources, and allow/deny lists. Agent SDK `0.3.312` adds typed auto-mode settings, while `0.3.314` fixes excluded setting sources leaking auto-mode rules and saved consents. Cyrus's explicit mode keeps its existing manual policy authoritative across first-party, Bedrock, Vertex, Foundry, Mantle, and telemetry-disabled paths.
- **Default-on fork subagents:** Agent SDK `0.3.302` enables `subagent_type: "fork"` by default and retains background execution; `CLAUDE_CODE_FORK_SUBAGENT=0` disables it. Cyrus keeps `Task` available and intentionally injects no blanket opt-out, so the upstream default applies subject to Cyrus's normal permission and sandbox policy. The affected-path test asserts `Task` forwarding and absence of an injected opt-out.
- **AskUserQuestion:** `0.3.312` adds capability-gated `unanswered` annotations. Cyrus's existing `canUseTool` handler still returns answered/denied outcomes and does not synthesize the new state.
- **Tools, results, and tasks:** The 30-tool registry matches the bundled CLI. `TaskOutput` remains excluded from new defaults while formatter compatibility remains for historical activity. Tests cover `task_updated` → `task_notification` → `background_tasks_changed` ordering and detached/omitted/error MCP result envelopes.
- **Monitor and foreground commands:** `Monitor` remains configured. A background task or timeout is not equivalent to the required foreground `Bash(pwd)` receipt.
- **Retry and startup timeout:** The reviewed range includes unattended retry watchdog events and startup-timeout changes. A provider 401 remains a failed gate and is not hidden by retries or a success-shaped envelope.
- **Unknown third-party model names:** Claude Code `2.1.312` gives unrecognized Bedrock, Vertex, Foundry, and Mantle model/deployment names the shorter system prompt and automatic post-refusal fallback. Cyrus passes custom `model` and `fallbackModel` values verbatim and intentionally sets neither `CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT=0` nor `CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK=1`. The provider matrix asserts that policy for all four selectors.
- **Prompt and agent hook concurrency:** Claude Code `2.1.312` caps prompt and agent hooks at 24 running callbacks per session, including subagents, plus 12 callbacks waiting beyond their declared timeout; sub-second timeouts count as one second. Cyrus neither raises nor disables that upstream ceiling. Tests verify caller prompt/Stop hook matchers and sub-second timeouts are forwarded unchanged and that Cyrus's pending-work Stop recorder is appended.
- **Subagent compaction precedence:** Agent SDK `0.3.296+` exposes `AgentDefinition.autoCompactWindow`; Claude Code `2.1.312` makes the per-agent value lower, but not raise, `CLAUDE_CODE_AUTO_COMPACT_WINDOW`. Cyrus injects neither a global window nor programmatic agent definitions. It retains user/project/local setting sources, so configured agents keep upstream lower-only precedence; the affected path asserts those omissions.
- **Cache-lifetime fields:** `0.3.311` adds optional five-minute and one-hour cache-creation fields. They are additive telemetry/type fields and do not establish runtime success.
- **MCP provenance and managed mounts:** Authorization must use SDK-provided provenance, never a spoofable server name. `mcpMount` is managed-mount provenance, not equivalent to trusted `sdk` provenance.
- **Managed plugin trust:** Trust depends on managed `pluginDigests` matching plugin directory contents; a name or path alone is not trusted.
- **Signed model catalog:** Claude Code `2.1.311+` loads a signed model catalog by default for Bedrock, Mantle, Vertex, and Foundry; `CLAUDE_CODE_MODEL_CATALOG=off` opts out. Cyrus does not silently alter that provider policy.
- **Sandbox and write boundaries:** `0.3.314` adds `sandbox_required_unavailable` and `permissions.blockWritesOutsideWorkingDirectories`. When sandboxing is configured, Cyrus keeps it enabled, disallows unsandboxed commands, retains weaker network isolation, and does not add excluded commands; the edge-worker contract test asserts this configuration.
- **API SDK and telemetry:** API SDK `0.134.0` can enable OpenTelemetry, and `1.0.0` changes the default API version to `2026-10-21`. The updated consumers use the API SDK for types; no new inference client is introduced here. Hosted request-level tests establish Bearer authentication and the new API version, and explicitly disable SDK spans and trace propagation so Sentry remains the application tracing owner.


## Additional .315/.316 dispositions

- **Server-managed settings:** `.316` applies API-fetched policy to Team/Enterprise logins without the former approval prompt and refuses stored policy that fails verification. Keep that upstream policy; do not reintroduce approval prompts or bypass validation. Current Max-account doctor output establishes non-applicability to this test identity only. Team/Enterprise enforcement has not been exercised by this receipt or by option mocks.
- **Managed auto-mode lists:** `.316` keeps an administrator's `autoMode.allow` list without `$defaults` from regaining built-in exceptions through host settings or later UI changes. Explicit `permissionMode: default` keeps Cyrus's normal manual policy, but does not override managed restrictions. No host-side policy rewriting is introduced.
- **Read exemptions:** `.316` adds `permissions.blockReadsExemptPaths`, honored only from host/flag settings, not user/project/local/managed files. These are read-boundary exceptions, not automatic grants, working directories, write access, MCP exposure or sandbox read allowances. Invalid/relative/tilde/root/traversal paths are ignored; patterns and symlinks are not expanded. Cyrus does not inject this option. Its `allowedDirectories` tool grants/home-deny exclusions and `additionalDirectories` working-directory behavior stay distinct. The installed types support this disposition; actual enforcement outside the working directory has not been demonstrated by the ordinary Read(package.json) gate.
- **Other runtime deltas:** retain `.316` cleanup of shell processes on CLI exit, inherited subagent model handling, alias fallback on Bedrock/Vertex, and additional-directory CLAUDE.md loading. No new subagent effort or ultrathink override is injected. SDK `.315` is a bundled parity update with no separately listed SDK API change.

## Tool registry and companion protections

The prior mandatory `.316` extraction found 30 built-in tools unchanged, plus environment MCP tools. The executable package sources and `config.ts` remain unchanged in this reconciliation; extraction is not repeated while access is unestablished because the script sends a model request. Tool-name parity is not behavior validation. `TaskOutput` stays out of new defaults; historical formatters remain supported.

Hosted keeps its wider effective range, exact-only default migration (custom/reordered/empty/NULL/historical values protected), wire/version and telemetry contracts, HTML/plaintext/options tests, frozen install and production-build gate. This PR neither claims to revalidate Hosted's source nor changes that companion.

## F1 protocol and local validation

Fresh test repo: `/private/tmp/cyrus-1570-f1-repo`; server port 3600.

- [x] Fresh repository created; server starts; ping healthy; status ready.
- [x] Server shut down gracefully after setup validation, with zero sessions.
- [x] Local issue `issue-1` / `DEF-1` created with the required runtime criteria.
- [ ] Session/worktree execution, activity rendering/pagination and final response: held before session start to avoid an unauthorized blind provider retry.
- [ ] Successful integrated installed runner/core runtime receipt: still required.
- [x] Full workspace `pnpm -r test:run` (includes package and CLI tests), build and typecheck pass.
- [x] Lint passes with 14 existing warnings; dependency audit reports zero advisories.
- [x] Receipt validator: 13/13 tests pass; no provider calls.

F1 control-plane setup is partial validation, not an end-to-end pass. Final-head CI and immutable package preparation are recorded with this report's companion artifact; authenticated acceptance remains held until an actual successful receipt is attached.

## Prepared immutable package artifact

[Package provenance](assets/2026-10-31-cypack-1609-package-provenance.json) records source commit `bc8455175e94328f38cef0299154bb54688b0602`, source tree and lock, both local tarballs and installed integrities, and installed runner/core/SDK/native byte hashes. Runner and core resolve one deduplicated `.316` SDK and API SDK `1.3.0`; the clean consumer audit has zero vulnerabilities. Installed mocked contracts pass 6/6 configurations, separately from the 13 receipt-validator tests. Neither is a runtime pass. No package sources changed after this source commit; later commits contain evidence only.

Consumer: `/private/tmp/cyrus-1570-consumer`. Tarballs: `/private/tmp/cyrus-1570-artifacts`. These are local preparation artifacts, not a new npm publication. Rebuilding elsewhere requires recording the new tarball/lock identities before using its receipt.
