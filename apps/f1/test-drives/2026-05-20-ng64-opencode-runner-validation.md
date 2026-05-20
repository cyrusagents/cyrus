# NG-64 OpenCode Runner Validation F1 Test Drive

**Date**: 2026-05-20
**Goal**: Validate the OpenCode runner end to end with F1 session activity visibility.
**Test Repo**: `/tmp/f1-test-drive-ng64-opencode-validation-20260520-1139`
**Branch**: `ng-64-validate-opencode-runner-end-to-end-with-tests-and-f1`

## Environment

- F1 server: `http://localhost:3600`
- Cyrus home: `/var/folders/_r/fld8l71j7ts635hlb5vtgnb80000gn/T/cyrus-f1-1779269986448`
- OpenCode CLI: `/opt/homebrew/bin/opencode`, version `1.15.5`
- Live probe command:

```bash
OPENCODE_LIVE=1 OPENCODE_PROBE_MODEL=openai/gpt-5.5 \
  pnpm --filter cyrus-edge-worker exec vitest run test/opencode-cli-probe.live.test.ts
```

## Verification Results

### Issue-Tracker

- [x] Issue created as `DEF-1`
- [x] Issue ID returned as `issue-1`
- [x] Repository selection elicitation posted

### EdgeWorker

- [x] Session started as `session-1`
- [x] Worktree created for `DEF-1`
- [x] OpenCode runner selected from `[agent=opencode]` plus `opencode` label
- [x] OpenCode completed successfully
- [x] Session stopped cleanly

### Renderer

- [x] Timeline showed elicitation, user prompt, routing thoughts, model selection, tool action, and final response
- [x] OpenCode text output was rendered as the final response
- [x] Tool/file activity was visible as a `Read` action
- [x] Pagination works with `--limit 3 --offset 0`

## Session Log

```bash
apps/f1/f1 init-test-repo \
  --path /tmp/f1-test-drive-ng64-opencode-validation-20260520-1139

CYRUS_PORT=3600 \
CYRUS_REPO_PATH=/tmp/f1-test-drive-ng64-opencode-validation-20260520-1139 \
  bun run apps/f1/server.ts

CYRUS_PORT=3600 apps/f1/f1 ping
CYRUS_PORT=3600 apps/f1/f1 status

CYRUS_PORT=3600 apps/f1/f1 create-issue \
  --title "NG-64 OpenCode runner validation" \
  --description $'Validate OpenCode runner end to end for NG-64.\n\n[agent=opencode]\n\nPlease inspect src/index.ts using a read tool and respond with one concise sentence describing what it exports. Do not modify files.' \
  --labels opencode

CYRUS_PORT=3600 apps/f1/f1 start-session --issue-id issue-1
CYRUS_PORT=3600 apps/f1/f1 view-session --session-id session-1 --limit 80 --offset 0
CYRUS_PORT=3600 apps/f1/f1 prompt-session --session-id session-1 --message "test-repo"
CYRUS_PORT=3600 apps/f1/f1 view-session --session-id session-1 --limit 120 --offset 0
CYRUS_PORT=3600 apps/f1/f1 view-session --session-id session-1 --limit 3 --offset 0
CYRUS_PORT=3600 apps/f1/f1 stop-session --session-id session-1
```

Key timeline entries:

```text
elicitation  Which repository should I work in for this issue?
prompt       test-repo
thought      Routing (User selection) - F1 Test Repository
thought      Using model: opencode
action       {"type":"action","action":"Read","parameter":"/private/var/.../src/index.ts"}
response     `src/index.ts` exports the `RateLimiter` class and a set of ...
```

Server logs confirmed completion:

```text
Result message emitted to Linear (activity activity-8)
Session completed (subtype: success)
Stopped session session-1 (interrupt not supported)
Server stopped gracefully
```

## Limitations

- The live OpenCode probe remains opt-in because it requires local OpenCode credentials and a selected model. The default test run verifies the guard and documents the command without invoking the external model.
- The F1 run used a read-only prompt to validate selection, text output, and tool activity visibility without mutating the test repository.

## Final Retrospective

PASS: Cyrus routed an F1 issue to OpenCode, isolated OpenCode state through the runner configuration, displayed OpenCode model selection and tool activity in the session timeline, rendered the final OpenCode response, and stopped the session cleanly.
