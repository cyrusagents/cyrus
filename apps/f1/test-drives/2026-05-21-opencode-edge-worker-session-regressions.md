# Test Drive: OpenCode Edge-Worker Session Regressions

**Date**: 2026-05-21
**Goal**: Smoke-test F1 issue/session/activity flow after the OpenCode edge-worker session and permission fixes.
**Test Repo**: `/var/folders/_r/fld8l71j7ts635hlb5vtgnb80000gn/T/opencode/f1-session-regressions`

## Verification Results

### Issue-Tracker
- [x] Issue created
- [x] Issue ID returned: `issue-1` / `DEF-1`
- [x] Issue metadata accessible through session view

### EdgeWorker
- [x] Session started: `session-1`
- [x] Repository selection elicitation appeared
- [x] Repository selection response started processing
- [x] Activities tracked after routing

### Renderer
- [x] Activity format correct for elicitation, prompt, thought, and action rows
- [x] Pagination command worked with `--limit 10 --offset 0`
- [ ] Search not validated in this smoke test

## Session Log

```bash
./f1 init-test-repo --path /var/folders/_r/fld8l71j7ts635hlb5vtgnb80000gn/T/opencode/f1-session-regressions
CYRUS_PORT=3600 CYRUS_REPO_PATH=/var/folders/_r/fld8l71j7ts635hlb5vtgnb80000gn/T/opencode/f1-session-regressions bun run apps/f1/server.ts
CYRUS_PORT=3600 ./f1 ping
CYRUS_PORT=3600 ./f1 status
CYRUS_PORT=3600 ./f1 create-issue --title "OpenCode smoke: inspect rate limiter" --description "Smoke test for OpenCode edge-worker session behavior. Inspect the rate limiter repository and respond with a concise summary; do not make code changes."
CYRUS_PORT=3600 ./f1 start-session --issue-id issue-1
CYRUS_PORT=3600 ./f1 view-session --session-id session-1
CYRUS_PORT=3600 ./f1 prompt-session --session-id session-1 --message "f1-test-repo"
CYRUS_PORT=3600 ./f1 view-session --session-id session-1 --limit 10 --offset 0
CYRUS_PORT=3600 ./f1 stop-session --session-id session-1
```

Observed activities included repository selection elicitation, prompt receipt, routing thought, model thought, and a visible `Skill` action. Session stopped cleanly.

## Final Retrospective

The F1 smoke validated that the EdgeWorker can still create issues, start sessions, render selection and activity rows, process a repository selection, and stop cleanly after the OpenCode session changes. This did not run a full coding completion because the goal was session/activity regression coverage, and the session was stopped after activity visibility was confirmed.
