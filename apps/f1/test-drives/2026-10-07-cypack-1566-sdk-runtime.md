# Test Drive: Claude Agent SDK 0.3.292 runtime (CYPACK-1566)

**Date:** 2026-10-07 00:26 PDT  
**Result:** **PARTIAL — initialization passed; authenticated model execution blocked.**  
**Tested tree:** local CYPACK-1566 changes on base `8e786086b21c8dbbc72683830508517b99a62f05`  
**Fixture:** `/private/tmp/cypack-1566-f1.N6y2mr/repo`

## Changed behavior and assertions

The Agent SDK was advanced from 0.3.281 to 0.3.292. SDK 0.3.286 delegates an
omitted permission mode to Claude Code, which can select settings or automatic
mode. Cyrus now passes `permissionMode: "default"` explicitly.

The fixture committed `.claude/settings.local.json` with
`permissions.defaultMode=acceptEdits` and `DISABLE_TELEMETRY=1`. The F1 server's
real `claude_query_options` event reported:

- `cqo.permissionMode=default`
- all three setting sources (`user`, `project`, `local`)
- 30 refreshed built-in tools plus four scoped read allowances
- `hasCanUseTool=true`

This passes the changed initialization behavior through the real EdgeWorker and
ClaudeRunner path. The mandatory tool extraction independently reported the same
30-tool SDK registry as `packages/claude-runner/src/config.ts`.

## F1 results

- Server started on port 3602 and reported healthy/ready.
- `issue-1` / `DEF-1` routed to the primary F1 repository.
- `session-1` created its worktree and assigned a Claude session ID.
- Routing, model selection, and the terminal authentication error were rendered
  as timestamped activities.
- Offset/limit pagination and `Routing` search returned the expected activities.
- `stop-session` succeeded and SIGINT shut down the server cleanly.

## Authentication blocker

The installed Claude identity returned HTTP 401: `OAuth access token has
expired. Re-authenticate to continue.` No Read or Bash tool call and no
`SDK_RUNTIME_OK` model response occurred, so authenticated end-to-end execution
is not claimed. This is the same external credential blocker recorded by the
superseded CYPACK-1565 drive; reconnecting the existing identity is required to
close that remaining acceptance gate.

## Targeted verification

- `pnpm build` — passed.
- `pnpm --filter cyrus-claude-runner test:run` — 126 passed.
- `pnpm audit` — zero advisories.
- `./scripts/extract-claude-tools.sh` — 30 tools, no catalog changes.
- Published `cyrus-claude-runner@0.2.74-test.2` and
  `cyrus-core@0.2.74-test.7` under the `test` tag; both stable `latest` tags
  remained 0.2.73.
