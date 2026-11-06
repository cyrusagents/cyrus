# Release v0.2.76: runtime verification

**Date:** 2026-11-06
**Issue:** [CYPACK-1624](https://linear.app/ceedar/issue/CYPACK-1624)
**Release PR:** [#1584](https://github.com/cyrusagents/cyrus/pull/1584)
**Tested source:** `63ac2c8afd3232783f6be2d146482cd1aae55a61`; subsequent changes only update changelog dates and add this evidence.
**Previous published release:** `v0.2.75`
**Result:** PASS for the release checks described below. This does not assert npm publication; the main-only dry-run/live workflows remain separate gates.

## Full-payload assessment

Two product changes have merged since v0.2.75:

- **#1583, CYPACK-1623:** Agent SDK 0.3.318 / Claude Code 2.1.318, API SDK 1.5.0, and explicit manual permission mode on cold and pre-warmed sessions. The live F1 and installed-package checks below exercise this updated runner. The existing four-case regression covers auto/acceptEdits settings in both project and local settings files.
- **#1581:** Plane transport, coordinator, issue tracker, activities and MCP integration. Its 29 focused tests passed again on the release branch. The [merged feature PR](https://github.com/cyrusagents/cyrus/pull/1581) records live self-hosted Plane Commercial 4.0.1 coverage for assignment/mention, follow-up, repository selection, label routing, attachments, state changes, Markdown and progress replies. That evidence was captured on the contributor's branch with unrelated changes; it is not an exact-release-commit test. Stock F1 exercises the CLI tracker, not Plane's external API. No new live Plane or Plane Cloud coverage is claimed here.

This is a runtime-bearing payload; no non-F1 exemption is used. The previous failed attempt remains preserved in `2026-11-05-cypack-1624-release-attempt.md`.

## Test environment

The owner refreshed the existing Claude login. The initial successful cold turn on the default configuration could not be resumed because the agent sandbox does not permit transcript writes under the normal home configuration directory. Subsequent successful checks used a writable test directory while preserving the existing keychain identity:

```sh
CLAUDE_CONFIG_DIR=/private/tmp/cypack-1624-claude-config
CLAUDE_SECURESTORAGE_CONFIG_DIR=''
CYRUS_PORT=3614
CYRUS_REPO_PATH=/private/tmp/f1-cypack-1624-resume-repo
CYRUS_ENABLE_WARM_SESSIONS=1
```

These were per-process environment settings, not persisted host configuration. The installed SDK's credential-service selection supports an empty `CLAUDE_SECURESTORAGE_CONFIG_DIR` to retain its default keychain service when changing the transcript/config directory. Authentication status reported `claude.ai` / `firstParty`; no token was copied or alternate account selected.

The temporary F1 wrapper used the unchanged `apps/f1/server.ts` with its colors import resolved absolutely and one local test route added before startup:

```typescript
fastify.post('/cli/release-warmup', async () => {
  for (const session of edgeWorker.agentSessionManager.getAllSessions()) {
    edgeWorker.agentSessionManager.getAgentRunner(session.id)?.stop();
  }
  await edgeWorker.warmupRecentSessions();
  return { sessions: [...edgeWorker.warmInstances.keys()] };
});
```

The wrapper accesses private methods only to trigger the real warmup path deterministically after stopping the live runner. It does not mock SDK startup/query, runner attachment, webhook handling, or activity rendering. It is a temporary harness, not a production route or a full process-restart test.

## Live F1 results

1. Created `DEF-1` with `[repo=f1-test-repo]`, requested `Read(package.json)`, foreground `Bash(pwd, timeout=10000)`, then `SDK_RUNTIME_OK`, and supplied the memory marker `ORCHID_1624`.
2. Started `session-1`. Description-tag routing selected the test repository and created the worktree. The SDK initialized Claude Code **2.1.318** in **default** permission mode. Read and Bash actions were visible, followed by the exact final response **SDK_RUNTIME_OK**.
3. Prompted the same session to return the earlier marker. It returned **ORCHID_1624**, retaining session ID `32fa5cc9-1fa1-4b12-b3a0-ade9e8e90869`. Both result messages were successful and non-error. No `session_writes_lost` event occurred.
4. In a fresh F1 server, created a session that remembered the same marker and returned **COLD_READY**. Its persisted session ID was `e9642b51-630e-4ffc-8b9b-331d4de30bfb`.
5. Set `permissions.defaultMode` to `acceptEdits` in that temporary worktree's `.claude/settings.local.json`, preserving its other settings. Called `POST /cli/release-warmup`; it returned `{"sessions":["session-1"]}`.
6. Sent a follow-up through the normal F1 `prompt-session` RPC requesting Read, then Bash, then `WARM_` plus the remembered marker. The worker logged **Pre-warmed session session-1** and **Attaching pre-warmed session to runner config**. The real warm SDK initialized with the same persisted session ID, Claude Code **2.1.318**, and **default** permission mode despite the loaded acceptEdits setting.
7. The warm turn emitted Read and Bash action activities, then the exact final response **WARM_ORCHID_1624** and a successful, non-error result. No write-loss event occurred. This verifies persistence, warm attachment, policy selection, actual tool execution, and timeline output together.
8. Pagination returned the expected Read/Bash action slice. `stop-session` succeeded and all F1 servers started for this drive were stopped.

Successful drive logs are retained locally under `/private/tmp/cypack-1624-f1-writable.log` and `/private/tmp/cypack-1624-f1-warm-final.log`; raw logs are not committed because SDK diagnostics may include environment details.

## Installed-package runtime receipt

The isolated installation at `/private/tmp/cypack-1624-cli` contains all 18 inspected v0.2.76 tarballs. A bounded real `ClaudeRunner` request against the installed runner passed:

- Read of the fixture's package.json, then foreground Bash `pwd` with timeout exactly 10000, then exact final text `SDK_RUNTIME_OK`, in order;
- Claude Code 2.1.318, permission mode default;
- non-error successful result, completion callback, no pending work, inactive runner, and clean stop;
- no `session_writes_lost` message.

The SDK's successful Read result omits its optional `is_error` field. The receipt checks presence of the matched tool result and rejects `is_error: true`; it does not require an optional false field. The first model attempt batched tools, so the final request explicitly required waiting for the Read result before invoking Bash; the passing receipt asserts the actual ordering.

Receipt session: `b56556a6-ef11-4fc6-8ec7-d01c0d7587c8`.

Tarball SHA-256:

- `cyrus-core@0.2.76`: `b1ea0671bc0d48e9cd6cc62c230a59918dc921b25c56eaa09d4aaa450dba90d2`
- `cyrus-claude-runner@0.2.76`: `296a3a73ceb2a47541405254d0342217b115e2b39f5ceec9b49a8fbf72a49e69`

The test script and safe summary receipt are retained in the issue attachments directory under `release-verification/`. This is a v0.2.76 release receipt, not a retroactive claim that the separate core prerelease/Hosted companion work described in CYPACK-1623 was completed.

## Other checks and publication readiness

- `pnpm install`: passed; lockfile unchanged.
- `pnpm build`, `pnpm typecheck`, `pnpm test:packages:run`: passed.
- `pnpm --filter cyrus-ai test:run`: 162 passed.
- `pnpm lint`: passed with 14 existing warnings.
- `pnpm audit --audit-level low`: zero advisories; refreshed on November 6.
- `pnpm --filter cyrus-plane-event-transport test:run`: 29 passed across five files, refreshed on November 6.
- `pnpm --filter cyrus-edge-worker exec vitest run test/EdgeWorker.warm-session-permission-mode.test.ts`: four passed, refreshed on November 6.
- Installed-package permission contract: seven configurations passed.
- All 18 tarballs inspected for package identity, version, exact internal dependencies, and absence of workspace ranges; isolated installation returned CLI version `0.2.76`.
- PR CI at tested commit: all four Node 22/24 jobs passed.
- The owner completed Plane bootstrap and reported trusted-publisher setup; npm now exposes `cyrus-plane-event-transport@0.0.0-stage`. An unauthenticated local trust-settings read returned E401; the live OIDC workflow remains the definitive authorization test. Existing packages retain the previously used trusted repository/workflow identity.

Before publishing, run the canonical release validator, merge the reviewed PR, and complete the main-only dry run. Only after live publication and independent verification should CYPACK-1623 move from MergedUnreleased to ReleasedMonitoring.
