# CYHOST-909 OAuth gateway: F1 protocol attempt

**Result: BLOCKED before tool invocation.** This is a real local F1/EdgeWorker/Claude attempt, not a successful hosted Cloud session. F1 applies to major hosted undertakings even when no CLI code changes.

## Versions and configuration

- Cyrus source: `d0c11e543487f504c69e81007d249c04e513c092` (v0.2.72).
- Hosted preview at invocation: `ff27c596e413c7e47327ddb0685ffa9f5572dff1`, https://cyrus-preview-cyhost-909.vercel.app.
- Fresh repository: `/private/tmp/f1-cyhost909-review`; F1 port 3609.
- F1 home: `/tmp/cyrus-f1-1789511237973`; worktree: `worktrees/DEF-1`.
- An ephemeral copy of `apps/f1/server.ts` set the primary repository's `mcpConfigPath` to `/private/tmp/cyhost-909-preview-mcp.json` and added `mcp__*` to `linearAllowedTools`. This file contained only the synthetic connection's gateway capability, never provider OAuth tokens. The temporary server copy was removed after the test. No runtime source was changed.

## Commands

From the Cyrus root:

```sh
COREPACK_HOME=/private/tmp/cyhost-909-corepack pnpm install --frozen-lockfile --store-dir /private/tmp/cyhost-909-pnpm-store
COREPACK_HOME=/private/tmp/cyhost-909-corepack pnpm --filter cyrus-f1... build
cd apps/f1
./f1 init-test-repo --path /private/tmp/f1-cyhost909-review
CYRUS_PORT=3609 CYRUS_REPO_PATH=/private/tmp/f1-cyhost909-review bun run server.oauth-validation.ts
```

In another terminal, from `apps/f1`:

```sh
CYRUS_PORT=3609 ./f1 ping
CYRUS_PORT=3609 ./f1 status
CYRUS_PORT=3609 ./f1 create-issue --title 'CYHOST-909 hosted OAuth harmless tool validation' --description 'Validation only: invoke configured read_greeting OAuth MCP tool, wait 35 seconds, invoke again. Do not edit files or use unrelated tools. Report auth failure without credentials.'
CYRUS_PORT=3609 ./f1 start-session --issue-id issue-1
CYRUS_PORT=3609 ./f1 prompt-session --session-id session-1 --message 'Use [repo=f1-test-repo]. Only validate the configured OAuth read_greeting tool.'
CYRUS_PORT=3609 ./f1 view-session --session-id session-1 --limit 10 --offset 0
CYRUS_PORT=3609 ./f1 view-session --session-id session-1 --limit 10 --offset 10
CYRUS_PORT=3609 ./f1 view-session --session-id session-1 --search 'authenticate'
CYRUS_PORT=3609 ./f1 stop-session --session-id session-1
```

Server stopped with Ctrl-C; failed test repository/worktree preserved for diagnosis.

## Observed activity and lifecycle

| UTC timestamp | Observation |
| --- | --- |
| 2026-09-15 22:27:37 | `issue-1` / `DEF-1`, `session-1` created. Repository elicitation appeared. |
| 22:28:19 | Follow-up selected `f1-test-repo`; routing activity and real Git worktree created. |
| 22:28:22 | Claude runner selected `claude/claude-sonnet-5`. |
| 22:28:24 | Error activity: `Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue.` |
| 22:28:42 | Stop produced a final response activity and session status `complete`. This status means stopped, not acceptance passed. |

Renderer displayed timestamp/type/message columns. Pagination offset 10 returned no rows, and the authentication search returned one error activity. Seven total activities were retained after stop. No successful tool activity or greeting was produced. The gateway file was configured as a runner input, but authenticated MCP initialization and model invocation are not proven by this failed run.

## Remaining proof and retrospective

A funded dedicated test API key or refreshed authorized test Claude login is required. The separate dedicated-key attempt returned insufficient credits; no credits were purchased and no customer credentials were used. The operator is handling these prerequisites.

After credentials are available, run the actual provisioned **Cloud** worker through the harmless tool before and after expiry, reconnect, disconnect, and wrong-workspace rejection. Record the Cloud session ID, CLI version, config delivery, audit events, and immutable deployed head. Local F1, browser, HTTP scripts, and SDK stream-recovery results must remain distinct from this proof.

Hosted implementation and evidence: [cyrus-hosted PR #1084](https://github.com/cyrusagents/cyrus-hosted/pull/1084). Scoped guide: [documentation PR #42](https://github.com/cyrusagents/documentation/pull/42). [CYHOST-909](https://linear.app/ceedar/issue/CYHOST-909) remains open. No merge or production deployment.
