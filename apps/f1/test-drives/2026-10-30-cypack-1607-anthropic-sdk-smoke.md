# CYPACK-1607: Anthropic SDK 0.3.314 runtime review

**Date:** 2026-10-30

**Goal:** Advance Cyrus from Claude Agent SDK `0.3.281` to `0.3.314` and Anthropic API SDK `0.128.0` to `1.3.0`, while retaining the permission, package, Hosted migration, and authenticated-runtime gates established during CYPACK-1605.

**Review-subject heads:** cyrus `21e2e64861e2803c4e615ab2a327456af2dcae6f`; cyrus-hosted `e7aaf3be10b0ec425adec2e37bff626da192f69b`.

**Reconciliation validation heads:** cyrus executable/test changes `e69f9ed4e363d16c1626cc672de1fe1ef4c75458`; cyrus-hosted `d41af090e0fdfb5bc039d091b066a61a02d4d95d`.

**Pull requests:** [cyrus#1567](https://github.com/cyrusagents/cyrus/pull/1567), [cyrus-hosted#1293](https://github.com/cyrusagents/cyrus-hosted/pull/1293)

## Exact effective ranges

The official [Agent SDK changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md#03314), corresponding Claude Code history, and [Anthropic API SDK 1.3.0 release](https://github.com/anthropics/anthropic-sdk-typescript/releases/tag/sdk-v1.3.0) were reviewed through the selected versions.

- Cyrus CLI/runtime: Agent SDK `0.3.281` through `0.3.314`; API SDK `0.128.0` through `1.3.0`.
- Hosted effective core/runtime: Agent SDK `0.3.268` through `0.3.314`; API SDK `0.125.0` through `1.3.0`.
- Embedded Claude Code: the corresponding runtime range through `2.1.314`.

The Hosted range is intentionally wider than the CLI range because its previous `cyrus-core@0.2.72-test.5` pin carried Agent SDK `0.3.268`.

## Immutable final-head package identity

No additional package was published for the independent review. Local immutable tarballs were built from the exact cyrus head and installed together in a fresh npm consumer:

- `cyrus-claude-runner@0.2.74`: SHA-256 `bbd0231c4031aacf4106dc57ec03fae457c481aa48f5c24b826045f6dda2d188`; installed integrity `sha512-eqNi3K+e2R6BfJsI1fuwRq9pajzY4ARXmXIZz3NA1KJdQ+gfzuuNU8jtXc4iMXGU+kokQ7l8nNytwUlBzbwQsg==`.
- `cyrus-core@0.2.74`: SHA-256 `68c1c13fd877b4abe274520980c9432de491ec9a6c05a9f41f6068af940dd516`; installed integrity `sha512-hat4VejkQ0vuapdFz6u+GGb3Xlmvew1pRN5lvmOMZCcgEXN0KA/rCdRYkpKropQDLc+ajsykqDY8V8qJP/nfpQ==`.
- Consumer lock SHA-256: `fe790c29bd1d163e58f048e544c3a1f0ba1ba8a0ddd5d0274a18b4738a4d24e4`.
- Resolved graph: runner/core `0.2.74` → Agent SDK `0.3.314` → API SDK `1.3.0`, with one deduplicated copy of each SDK and zero audit findings.
- The installed mocked package-contract verifier passed all six first-party/third-party-provider and telemetry configurations with explicit `permissionMode: "default"`.

The previously published `cyrus-core@0.2.75-test.10` remains the immutable Hosted pin. Its `test` tag changed during the original CYPACK-1607 implementation; `latest` remained `0.2.73`. The independent review did not publish or move a tag.

## Intended identity and bounded-request preflight

- Host: Darwin arm64; Node `v22.17.1`; OS user `agentops`, UID 502.
- The native Claude Code `2.1.314` binary installed with Agent SDK `0.3.314` reported `loggedIn: true`, `authMethod: claude.ai`, `apiProvider: firstParty`, Max subscription, account `connor@ceedar.io`, and organization `connor@ceedar.io's Organization`.
- No `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, or `CLAUDE_CODE_OAUTH_TOKEN` variable name was present. No credential, identity, provider configuration, or running Cyrus process was read, changed, refreshed, or substituted.
- The final installed-package request used model alias `opus`, fallback `sonnet`, `maxTurns: 5`, built-in tools `Read` and `Bash`, allowed `Read` and `Bash(pwd)`, disallowed `Edit`, `Write`, and `NotebookEdit`, strict MCP configuration, and a 120-second outer watchdog.

## Final integrated runner/package request

Exactly one authenticated request was made through the clean consumer's installed final-head runner/core pair. The prompt required, in order:

1. real `Read` of the consumer's `package.json`;
2. foreground `Bash` command exactly `pwd` with timeout `10000`;
3. final text exactly `SDK_RUNTIME_OK`.

The request ended after about six seconds with:

```text
Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue.
```

The provider rejected the request before either tool ran. Cyrus surfaced the SDK error through its error callback and the verifier failed closed. There is no `Read` receipt, foreground `Bash(pwd)` receipt, `SDK_RUNTIME_OK`, non-error terminal result, or accepted final clean-stop gate. The request was not repeated.

This is a point-in-time access result for the diagnosed existing identity, not a claim that the identity can never be refreshed. Re-authentication would change credential state and was neither performed nor replaced with another identity. A successful authenticated final-package receipt remains required before runtime acceptance.

## Tool registry refresh

`./scripts/extract-claude-tools.sh` ran against Claude Code `2.1.314`. The init block exposed 30 built-in tools, exactly matching `packages/claude-runner/src/config.ts`; no built-in name addition or removal was required. Nine environment-provided `mcp__agent-waymark__*` tools were also present and correctly remain outside the static built-in registry.

Name parity is not treated as behavioral acceptance. The compatibility tests and dispositions below cover the affected permission, task, hook, provider, sandbox, and result paths separately.

The core defaults already omit retired `TaskOutput`. Hosted can still store the previous exact defaults, so its companion migration removes `TaskOutput` only from exact prior Linear, Slack, and GitHub arrays. Customized, reordered, empty, `NULL`, and historical arrays remain unchanged, and the migration is idempotent.

## Compatibility dispositions through 0.3.314

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
- **Sandbox and write boundaries:** `0.3.314` adds `sandbox_required_unavailable` and `permissions.blockWritesOutsideWorkingDirectories`. Cyrus keeps its sandbox enabled, disallows unsandboxed commands, retains weaker network isolation, and does not add excluded commands; the edge-worker contract test asserts this configuration.
- **API SDK and telemetry:** API SDK `0.134.0` can enable OpenTelemetry, and `1.0.0` changes the default API version to `2026-10-21`. Cyrus only imports/re-exports API types. Hosted request-level tests establish Bearer authentication and the new API version, and explicitly disable SDK spans and trace propagation so Sentry remains the application tracing owner.

## Hosted companion validation

The companion keeps the exact-only migration and its custom, reordered, empty, `NULL`, and historical protections. Its API wire and tracing tests, tool-default tests, migration test, and React Email HTML/plaintext/options compatibility tests pass.

The Hosted lock is frozen at Bun lock SHA-256 `e53be0ddab94c4b91f98094f8b2f1f058cf44ab388d4436e51d54cc057711d4d`; `bun install --frozen-lockfile` makes no changes. The source archive for executable head `391765a72f0ed2ca6e8f608aacf6a41aa6147aec` had SHA-256 `6712ae34983bcbf855f48fe5c261af1d3e4e1a14f28d3aa961f1fb09c4715184` and was verified in ephemeral Vercel Sandbox `sbx_NA3cDhrSPalz7XQZKE3lEH4zcvQL` using Linux, Node `v22.23.4`, and Bun `1.4.0`:

- affected-path suite: 14 passed, 0 failed across the API wire/tracing, tool-default, exact-only migration, and React Email HTML/plaintext/options files;
- lint: 3/3 workspaces plus repository policy passed;
- typecheck: 11/11 tasks passed;
- production build: 4/4 workspaces passed, including the Hosted Next.js application and design-system documentation;
- final application build ID: `sBAuaWaHg3ehRDhcwHZRC`;
- final lock SHA-256 remained `e53be0ddab94c4b91f98094f8b2f1f058cf44ab388d4436e51d54cc057711d4d`.

The first isolated build intentionally had no application credentials and correctly failed during page-data collection because `src/lib/email/resend.ts` eagerly constructs a Resend client. The successful build used only the non-secret fixture `RESEND_API_KEY=re_ci_build_fixture`; it sent no email and supplied no production credential. That supported build fixture, frozen install, and production build gate are committed in the Hosted workflow at `d41af090e0fdfb5bc039d091b066a61a02d4d95d`. The sandbox was stopped after evidence collection.

GitHub Actions run `41086928105` did not start a runner because the repository account reported a payment/spending-limit problem. That external admission failure is not represented as a test result; the isolated Linux receipt above supplies the final-head product validation while the required workflow remains configured for the next admitted GitHub run.

No manual SQL, migration execution, deployment, credential change, or runtime restart was performed.

## Cursor reconciliation and retained security graph

Merged CYPACK-1603 / cyrus#1563 remains the base. This replacement retains Cursor SDK `1.1.0`, scalar `cwd`, the Cyrus-home/SHA-256 workspace store supplied to create and resume, final disposal, and the zero-advisory graph. CYPACK-1607 does not repeat or take ownership of Cursor provider acceptance.

## Current conclusion

Package identity, dependency resolution, zero-advisory audits, tool-name parity, permission and event contracts, upstream policy dispositions, exact-only migration behavior, frozen Hosted lock identity, and clean stopping of mocked package contracts are established.

Authenticated Agent SDK `0.3.314` tool execution is not established: the sole final integrated request was rejected by the provider before tools. The PR therefore remains draft and held on re-authentication of the intended existing identity followed by one successful final-package receipt; no substitute identity or blind retry was used.
