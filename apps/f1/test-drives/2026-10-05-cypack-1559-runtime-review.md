# Test Drive: SDK runtime review follow-up (CYPACK-1559)

**Date:** 2026-10-05
**Goal:** Preserve Cyrus permissions and verify an authenticated model/tool turn after the SDK refresh.
**Source:** PR #1525 revision based on `69eedb76cb393435374c595a74066b16d032b1cf`.
**Tested runner blob:** `f8caaee44cce9546f8524bf084eae8c7825a8a33` (`git hash-object packages/claude-runner/src/ClaudeRunner.ts`).
**Hosted companion:** `cyrus-hosted#1121` at `1dfb6f276151e073209f99c4170534108c5f74a0`.
**Test repository:** `/private/tmp/cypack-1559-f1-repo`, fixture commit `25f7a3d`.
**Result:** BLOCKED on live model authentication. This is not a successful end-to-end drive.

## Verification results

### Issue tracker / EdgeWorker / renderer

- [x] Fresh repository created with the F1 scaffold.
- [x] Fixture contains `.claude/settings.local.json` with `permissions.defaultMode=acceptEdits` and `DISABLE_TELEMETRY=1`.
- [x] Server health and ready status verified on port 3600.
- [x] Created `issue-1` / `DEF-1`, selected the Claude runner and Sonnet through description selectors, and routed by the `primary` label.
- [x] Started `session-1`; created `/tmp/cyrus-f1-1791239311103/worktrees/DEF-1`.
- [x] Query telemetry and the actual SDK `system/init` both report `permissionMode=default`; init reports Claude Code 2.1.289 and session `05db8c17-ea41-48d2-bfdb-ee6ee46bbd88`.
- [x] Routing, model-selection, and authentication-error activities are visible; timestamps, pagination (`--limit 2 --offset 1`), and search (`--search Routing`) work.
- [x] Session stopped through F1; server handled SIGINT and shut down gracefully.
- [ ] Completed model response.
- [ ] Real Read/Bash tool use and tool-result activities.
- [ ] Final `SDK_RUNTIME_OK` response.

## Commands and observations

After `pnpm install --frozen-lockfile` and `pnpm build`:

```sh
apps/f1/f1 init-test-repo --path /private/tmp/cypack-1559-f1-repo
# Add and commit the settings fixture described above.
CYRUS_LOG_LEVEL=INFO CYRUS_PORT=3600 \
  CYRUS_REPO_PATH=/private/tmp/cypack-1559-f1-repo DISABLE_TELEMETRY=1 \
  bun run apps/f1/server.ts
CYRUS_PORT=3600 apps/f1/f1 ping
CYRUS_PORT=3600 apps/f1/f1 status
CYRUS_PORT=3600 apps/f1/f1 create-issue \
  --title 'Verify SDK permission policy with real tools' --labels primary \
  --description 'Read README.md using Read, run pwd using Bash, then report the repository purpose and include SDK_RUNTIME_OK. Do not edit files, commit, push, or contact external integrations. [agent=claude] [model=sonnet]'
CYRUS_PORT=3600 apps/f1/f1 start-session --issue-id issue-1
CYRUS_PORT=3600 apps/f1/f1 view-session --session-id session-1
CYRUS_PORT=3600 apps/f1/f1 stop-session --session-id session-1
```

The active Claude CLI reports a logged-in account, but a model request and the
F1 turn both fail with `401 OAuth access token has expired`. Neither inherited
auth environment variable nor `~/.cyrus/.env` contains a nonempty Anthropic API
key or Claude OAuth token. Reauthentication was requested; credentials were not
changed. The SDK result is an authentication error, not a completed model turn.
Do not count initialization as fulfilling that acceptance criterion.

## Other validation

- `pnpm -r test:run`, `pnpm typecheck`, `pnpm lint`, and `pnpm build`: passed.
- Added runner boundary regression cases for settings, provider and telemetry
  environments, resume, tool rules, and the existing callback contract.
- Added synthetic stream/renderer tests for detached web result metadata and
  omitted MCP structured content. These verify forwarding/rendering, not a live
  network detachment or a real oversized MCP response.
- `node packages/claude-runner/test-scripts/permission-mode-smoke.mjs`: all nine
  **real SDK/CLI initialization** cases pass, including user/local `acceptEdits`,
  project `plan`, Bedrock, Vertex, Foundry, `DISABLE_TELEMETRY`, and `DO_NOT_TRACK`.
  The probe uses dummy auth and stops at init. No provider inference is claimed.
- `./scripts/extract-claude-tools.sh`: 30 tools, unchanged.
- Hosted exact head: frozen install, `bun run test`, `bun test`, `bun run typecheck`,
  `bun run lint`, and all seven platform tool-default tests pass.
- Executed the companion SQL in an isolated PGlite/Postgres database, comparing
  its results to the installed `cyrus-core@0.2.74-test.4` constants. Untouched,
  current, custom, reordered, empty, NULL, mixed-platform, second-run, and
  new-team cases passed. Native local PostgreSQL could not allocate shared
  memory in the sandbox, so the fixture run used PGlite; no deployed DB was changed.
- Audit is **not clean** on these branch heads: Cyrus has the two existing high
  advisories (`node-forge`, `braces`); hosted also retains existing advisories.
  Their separate security PRs [#1524](https://github.com/cyrusagents/cyrus/pull/1524)
  and [hosted#1120](https://github.com/cyrusagents/cyrus-hosted/pull/1120) are now
  merged into main, but their fixes are not incorporated into these old branch heads.

## Remaining acceptance gate

Rerun the F1 scenario with valid auth on the pushed head and record the actual
Read/Bash results and final response. Background timeout behavior, managed host
policy enforcement, deferred remote MCP invocation, and detached web calls have
an explicit [compatibility decision](../../../docs/compatibility/anthropic-sdk-0.3.289.md)
but have not all been exercised live by this drive. The test report does not
claim the entire review is satisfied while the authentication gate remains open.
