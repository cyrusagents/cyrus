# Release v0.2.74: runtime and sandbox verification

**Date:** 2026-10-20  
**Issue:** [CYPACK-1592](https://linear.app/ceedar/issue/CYPACK-1592)  
**Release PR:** [#1548](https://github.com/cyrusagents/cyrus/pull/1548)  
**Prepared runtime payload:** `deddd88c` (runtime source from `96b4608d9b69f534694044f0b627351dcbaaf6b5`, coordinated versions and security lockfile refresh).  
**Test repository:** `/private/tmp/cypack-1592-f1/repo`

## Full-payload applicability

Reviewed all six commits since `v0.2.73`, including sandbox writable paths, Codex CLI/SDK 0.159.2 and GPT-6.1 Sol support, authorized inbox publication, self-host listener-port persistence, and dependency patches. Runtime changes require F1 coverage. Validation below combines a live issue/session drive, authenticated runtime MCP transport fixture, filesystem enforcement fixture, and focused existing suites. The listener-port persistence and backwards-compatible hosted responses are covered by ConfigApiClient/AuthCommand tests; no production hosted authentication was performed.

## Live F1 issue/session and Codex configuration

Started the stock F1 server with:

```sh
CYRUS_PORT=3601 \
CYRUS_REPO_PATH=/private/tmp/cypack-1592-f1/repo \
CYRUS_DEFAULT_RUNNER=codex CODEX_MODEL=gpt-6.1-sol \
CODEX_HOME=/private/tmp/cypack-1592-f1/codex-home \
CYRUS_SANDBOX_WRITABLE_PATHS=/Users/agentops/.cyrus/worktrees/CYPACK-1592/.release-f1-allowed \
bun run apps/f1/server.ts
```

The isolated Codex home reused the existing authenticated account for this local drive only; its temporary credential copy was removed after the session. No credentials were sent to CI or included in evidence.

Created `issue-1` / `DEF-1` with `[repo=f1-test-repo]`, asked the agent to write to the explicit allowed path and an unlisted sibling, and started `session-1`.

Passed assertions:

- Server health, issue creation, description-tag routing and worktree creation succeeded.
- Real Codex 0.159.2 selected `gpt-6.1-sol` and completed its turn with a final response.
- The actual recorded `turn_context` contained `workspace-write`, approval `never`, and the explicit allowed root; the denied sibling was absent. Existing repository, attachment and Git metadata roots remained present.
- Five timestamped activities included routing, model selection, thought, and final response. Pagination returned three activities followed by two.
- `stop-session` succeeded and the server was stopped.

Local enforcement was **blocked**, not passed: both shell attempts failed before executing with exit 71, `sandbox-exec: sandbox_apply: Operation not permitted`. This agent itself runs inside a macOS sandbox, which cannot start the nested sandbox. The final response accurately disclosed that neither path-specific assertion could be established locally. Filesystem enforcement was tested separately on an isolated CI host, below.

The initial run with the default Codex home also failed because that directory was not writable from the parent sandbox; using the temporary writable home resolved the session startup failure.

## Inbox publication transport

Command: `bun apps/f1/inbox-publication-drive.mjs` after `pnpm build`.

**PASS:** real EdgeWorker HTTP MCP registration, runtime context authentication, catalog discovery, two explicit-destination publications preserving text/inbox/idempotency key, matching queued receipts, and unauthenticated request rejection with HTTP 401. The receipt endpoint is a local fixture. This does not establish live OAuth setup, a dot/Cloud Work receiver, or receiving model execution.

## Existing checks and release audit

- `pnpm test:packages:run`: 1,915 passed across 16 package suites; one skipped test.
- `pnpm --filter cyrus-ai exec vitest run --testTimeout=30000 --hookTimeout=30000`: 162 passed. The extended local timeout accommodates subprocess-based release tests.
- `pnpm build` and `pnpm typecheck`: passed, including required commit hooks.
- `pnpm lint`: passed with 14 existing warnings. A generated local pnpm cache was moved outside the source tree before linting.
- `pnpm audit`: no known vulnerabilities after refreshing Axios's allowed `follow-redirects` resolution from 1.16.0 to 1.16.1. Axios 1.20.0 is already the latest direct dependency; no override or unrelated dependency update was introduced. The edge-worker and CLI suites were rerun after this refresh.
- Existing writable-path tests cover config/environment merging, tilde expansion, rejection of relative paths, both Codex sandbox representations, Claude OS/tool permission configuration, and preservation of read-only tool sets. Claude OS-level execution was not independently driven here.

## Isolated OS sandbox enforcement

**PASS** on a fresh GitHub-hosted `macos-15` runner at commit `5d81cc47250df6ce3f94915fc8773dcbfeaad982`: [validation run 39489691655](https://github.com/cyrusagents/cyrus/actions/runs/39489691655).

Reproducible fixture: `node apps/f1/test-drives/assets/cypack-1592-sandbox.mjs` after building the workspace. It uses the actual `RunnerConfigBuilder`, writable-path resolver and `CodexConfigBuilder`, then launches the bundled Codex sandbox with the resulting writable roots and network setting. It needs no model login or API credentials.

Assertions passed against actual files:

1. The issue-to-Codex config retains `workspace-write` and exactly the fixture workspace plus the operator-whitelisted root.
2. Writing `allowed` inside the extra root succeeds.
3. Writing `workspace` inside the working directory succeeds.
4. Writing to the unlisted sibling fails; the denied file does not exist.

Observed output: `PASS: issue config -> Codex config -> real OS sandbox: workspace and whitelisted writes succeed; sibling write denied.` The fixture removes its temporary files on exit. Its temporary CI workflow was removed after capturing this immutable run; the reproducible fixture remains with this report.

The earlier Linux fixture attempts did not pass: initial attempts used obsolete Codex sandbox CLI syntax, and the corrected command then hit `bwrap: setting up uid map: Permission denied` on the hosted Linux runner. These are recorded as unsuccessful setup attempts, not sandbox enforcement evidence. The successful run uses the current `codex sandbox` command and a fresh macOS host without a parent sandbox.

## Result

### Post-merge security refresh ([#1550](https://github.com/cyrusagents/cyrus/pull/1550))

The first main-branch dry run ([39491213671](https://github.com/cyrusagents/cyrus/actions/runs/39491213671)) stopped at audit before any publication. The registry reported three additional advisories affecting MCP SDK 1.31.0 and Vite 8.0.16.

Updated both direct MCP SDK owners to 1.32.1, Vitest and its companion packages to 4.1.12, and explicitly supplied Vite 8.3.4 as the CLI test runner's peer dependency. The existing OpenTelemetry security override now remains within 2.x; unconstrained resolution selected an incompatible 3.x peer. No security exclusions or new overrides were added.

Validation after the refresh:

- Frozen install with strict peers, zero-advisory audit, build, typecheck and lint passed (14 existing lint warnings).
- 1,918 package tests passed (two skipped) and all 162 CLI tests passed; CLI subprocess checks used the same 30-second local timeout as above.
- Three new real-HTTP tests exercise the production MCP connection-test handler: direct discovery succeeds, same-origin 307 discovery succeeds, and a cross-origin 307 fails without any request reaching the destination carrying custom credentials or an initialization body.
- Re-ran `bun apps/f1/inbox-publication-drive.mjs` against the rebuilt runtime and updated MCP SDK: authenticated catalog discovery, two stable publications, queued receipts and unauthenticated 401 all passed. The receiver remains a local fixture.
- The product does not configure experimental `taskStore`; session-task isolation is an upstream SDK fix, not a separately claimed Cyrus workflow.

Earlier issue/session and OS sandbox evidence is preserved above. The new runtime dependency behavior is covered by the refreshed MCP transport drive and connection-handler checks; test-tooling changes are covered by the full suites.

The changed Codex issue/session/model/configuration path and actual writable-root enforcement passed across the local F1 and isolated OS boundary checks. Inbox runtime transport and focused authentication/configuration regressions passed. Live Claude sandbox execution and real hosted inbox receiver acceptance remain outside the evidence claimed here. Release publication is gated separately by the main-only trusted workflow's package, audit, test, type, build, tarball and isolated-install checks.
