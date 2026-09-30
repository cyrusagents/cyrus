# Test Drive: CYPACK-1549 Release v0.2.73

**Date**: 2026-09-29
**Goal**: Validate the v0.2.73 payload's Claude SDK initialization, chat-session path, issue/session lifecycle, and activity rendering before publication.
**Initial prepared commit**: `7d5da416c59878e823e0cb9b69a9ff12486c89cc`
**Security follow-up commit**: `de89a343da33feec221366d2a23283c80b0eeeb1`
**Test repositories**: `/private/tmp/cypack-1549-release-v0.2.73-mDKNhs/repo` and `/private/tmp/cypack-1549-release-v0.2.73-mDKNhs/repo-codex`
**F1 ports**: `3600` (Claude) and `3601` (Codex)

## Payload assessment

The complete payload since `v0.2.72` includes runtime-bearing changes: the Claude Agent SDK upgrade to `0.3.281`, refresh of the Claude tool catalog, chat-session Linear-token refresh, and Linear webhook IP allowlist expansion. It also includes native TypeScript compiler work and release/test-channel infrastructure. The runtime session and chat paths therefore require F1 coverage. The source-IP allowlist and deterministic release tooling are validated by their focused suites because the F1 fixture does not inject public webhook source addresses or perform registry publication.

## Verification results

### Claude SDK and chat path

- [x] The upgraded `@anthropic-ai/claude-agent-sdk@0.3.281` initialized from the prepared workspace.
- [x] The refreshed 30-tool Claude catalog was supplied without the retired `TaskOutput` tool.
- [x] A Claude session ID was assigned and system/model activities were emitted.
- [x] A synthetic Slack chat event created its isolated workspace and shared auto-memory configuration, built the chat runner, and assigned a Claude session ID.
- [x] The chat token-refresh ordering regression is covered by the edge-worker suite.
- [ ] The Linear issue turn could not produce a successful live Claude response because the host OAuth access token was expired.
- [ ] The synthetic Slack reply could not be delivered because the fixture channel does not exist in the connected Slack workspace.

### Complete issue/session smoke

- [x] F1 server health and readiness checks passed.
- [x] Issue `issue-1` / `DEF-1` was created.
- [x] Repository selection completed and a git worktree was created.
- [x] The authenticated Codex runner completed successfully and produced a final response.
- [x] Activities included elicitation, prompt, thought, action, and response entries with timestamps.
- [x] Pagination returned two 12-activity windows from 24 total activities.
- [x] The session stopped successfully and the server shut down gracefully.

### MCP dependency security follow-up

- [x] `@modelcontextprotocol/sdk@1.31.0`, `express-rate-limit@8.7.0`, and `ip-address@10.7.2` resolved without the prior MCP SDK or `ip-address` overrides.
- [x] `pnpm audit` reported no known vulnerabilities.
- [x] The F1 server started from the security follow-up commit and registered `/mcp/cyrus-tools` successfully through the updated SDK dependency graph.
- [x] The MCP tools suite passed 33 tests and the config-updater suite passed 55 tests.
- [ ] Direct MCP `initialize` cannot be exercised in current F1 CLI mode because `McpConfigService` intentionally omits a cyrus-tools context when the CLI tracker has no real Linear client; the endpoint correctly rejected the synthetic unknown context.

## Session log

Built the prepared release through the repository commit hook, which completed the monorepo build and typecheck, then created fresh F1 repositories:

```bash
apps/f1/f1 init-test-repo --path /private/tmp/cypack-1549-release-v0.2.73-mDKNhs/repo
apps/f1/f1 init-test-repo --path /private/tmp/cypack-1549-release-v0.2.73-mDKNhs/repo-codex
```

Started the Claude scenario and verified server health:

```bash
CYRUS_PORT=3600 CYRUS_DEFAULT_RUNNER=claude \
  CYRUS_REPO_PATH=/private/tmp/cypack-1549-release-v0.2.73-mDKNhs/repo \
  bun run apps/f1/server.ts
CYRUS_PORT=3600 apps/f1/f1 ping
CYRUS_PORT=3600 apps/f1/f1 status
```

Created and routed the inspection issue, then dispatched a synthetic Slack chat event:

```bash
CYRUS_PORT=3600 apps/f1/f1 create-issue \
  --title "Release v0.2.73 Claude SDK validation" \
  --description "Inspect README.md in the configured test repository and reply with exactly one sentence summarizing the project status. Do not edit files."
CYRUS_PORT=3600 apps/f1/f1 start-session --issue-id issue-1
CYRUS_PORT=3600 apps/f1/f1 prompt-session --session-id session-1 \
  --message "Use the configured F1 Test Repository for this issue."
CYRUS_PORT=3600 apps/f1/f1 start-chat-session \
  --channel C_RELEASE_073 --user U_RELEASE_TEST \
  --text "Reply with exactly: release chat path ready"
```

Result: both Claude paths initialized SDK `0.3.281` and received session IDs. The issue path rendered a clear expired-OAuth error. The chat path created the expected workspace and auto-memory configuration; the fake channel prevented Slack delivery. `stop-session` and SIGINT cleanup succeeded.

Repeated the issue flow on port 3601 with the authenticated Codex runner. It completed with subtype `success`, produced 24 coherent timeline activities and a final response, and passed pagination and stop checks:

```bash
CYRUS_PORT=3601 apps/f1/f1 view-session --session-id session-1 --limit 12 --offset 0
CYRUS_PORT=3601 apps/f1/f1 view-session --session-id session-1 --limit 12 --offset 12
CYRUS_PORT=3601 apps/f1/f1 stop-session --session-id session-1
```

Focused payload checks also passed:

```bash
pnpm --filter cyrus-edge-worker test:run -- chat-sessions.test.ts
pnpm --filter cyrus-core test:run -- WebhookIpValidator.test.ts
pnpm --filter cyrus-claude-runner test:run -- config.test.ts
pnpm --filter cyrus-ai exec vitest run \
  release-publish.test.ts release-workflow.test.ts test-release.test.ts \
  release-evidence.test.ts test-cli-artifacts.test.ts \
  --testTimeout=30000 --hookTimeout=30000
```

Results: edge-worker 845 passed / 1 skipped, core 193 passed, Claude runner 120 passed, and 59 focused release tests passed. The release tests need a 30-second local timeout on this host because their fake-registry child processes exceed Vitest's default 5-second limit; no assertion failed under the extended timeout.

After the mandatory audit discovered newly published `ip-address` advisories, the direct MCP SDK dependencies were advanced to `1.31.0`, the compatible transitive graph was refreshed to `express-rate-limit@8.7.0` and `ip-address@10.7.2`, and the redundant MCP SDK and `ip-address` overrides were removed. The post-patch checks were:

```bash
pnpm audit
pnpm --filter cyrus-config-updater test:run
pnpm --filter cyrus-mcp-tools test:run
CYRUS_PORT=3602 CYRUS_DEFAULT_RUNNER=codex \
  CYRUS_REPO_PATH=/private/tmp/cypack-1549-release-v0.2.73-mDKNhs/repo-codex \
  bun run apps/f1/server.ts
CYRUS_PORT=3602 apps/f1/f1 ping
CYRUS_PORT=3602 apps/f1/f1 status
```

Result: audit was clean, 88 focused tests passed, the F1 server became ready, and the cyrus-tools MCP endpoint registered successfully. A direct `initialize` request with an invented context returned the expected `Unknown cyrus-tools MCP context` error because CLI mode deliberately has no real Linear client from which to build that context.

## Limitations

1. `claude auth status` reported a logged-in Max account, but live SDK turns returned `401 OAuth access token has expired`; interactive reauthentication is outside this release session. SDK initialization, tool delivery, session-ID assignment, and error activity mapping were still exercised.
2. The Codex runner's macOS sandbox bootstrap rejected local shell startup, so its final response accurately reported that it could not read the fixture README. The issue, routing, runner, activity, response, pagination, stop, and shutdown paths completed successfully.
3. The synthetic Slack channel intentionally does not exist in the real Slack workspace, so reaction/reply API calls returned `channel_not_found` after the local chat path ran.
4. `f1 ping` still prints `Status: undefined` on a successful health response, the existing CLI/RPC field-name mismatch.
5. F1 CLI mode deliberately cannot prebuild an authenticated cyrus-tools MCP context because its issue tracker is local rather than a real Linear client. Endpoint registration and the package/config integration suites passed after the MCP SDK security bump; authenticated protocol exchange remains covered by the existing non-CLI integration fixtures.

## Final retrospective

The release payload's relevant local runtime boundaries were exercised: upgraded Claude SDK initialization and tool configuration, chat-session setup, issue routing/worktree creation, activity rendering, response delivery through an independently authenticated runner, pagination, stop, and graceful shutdown. Focused tests cover the exact token-refresh ordering, published Linear IP set, Claude tool catalog, and release-registry behavior. The remaining limitations are external credentials/channel validity and the known local Codex sandbox bootstrap issue, not failures in the prepared v0.2.73 release payload.
