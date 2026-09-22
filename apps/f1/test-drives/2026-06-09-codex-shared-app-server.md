# Test Drive: Codex shared app-server smoke

**Date**: 2026-06-09
**Goal**: Validate that the Codex app-server path still runs end-to-end after changing the runner to share one app-server process across threads.
**Test Repo**: `/tmp/f1-codex-shared-appserver-20260609-153237`

## Verification Results

### Issue-Tracker
- [x] Issue created (`issue-1`, `DEF-1`)
- [x] Issue ID returned
- [x] Repository selection elicitation and prompted response worked

### EdgeWorker
- [x] Session started (`session-1`)
- [x] Worktree was selected/created
- [x] Codex runner selected
- [x] App-server session started (`019eae8a-2b8a-74e3-b3ef-260c349dad48`)
- [x] Session completed successfully

### Renderer
- [x] Activity timeline showed elicitation, prompt, routing thoughts, model notification, and response
- [x] Final response activity contained `F1-CODEX-OK`

## Session Log

```bash
cd apps/f1
./f1 init-test-repo --path /tmp/f1-codex-shared-appserver-20260609-153237

ATMIKO_PORT=3601 \
ATMIKO_REPO_PATH=/tmp/f1-codex-shared-appserver-20260609-153237 \
ATMIKO_DEFAULT_RUNNER=codex \
CODEX_MODEL=gpt-5.5 \
CODEX_HOME=/tmp/codex-home-f1-auth \
bun run apps/f1/server.ts

ATMIKO_PORT=3601 apps/f1/f1 create-issue \
  --title 'Codex shared app-server smoke auth' \
  --description 'Smoke test only. Do not edit files. Reply exactly: F1-CODEX-OK'

ATMIKO_PORT=3601 apps/f1/f1 start-session --issue-id issue-1
ATMIKO_PORT=3601 apps/f1/f1 prompt-session \
  --session-id session-1 \
  --message 'F1 Test Repository'
ATMIKO_PORT=3601 apps/f1/f1 view-session --session-id session-1
```

Key result:

```text
response     F1-CODEX-OK
```

Server log evidence:

```text
[CodexRunner] hasCodexSubscription: true
[CodexRunner] Configured 1 MCP server(s) for codex config
Streaming session started: 019eae8a-2b8a-74e3-b3ef-260c349dad48
Session completed (subtype: success)
```

## Notes

- A first run with the default `/Users/agentops/.codex` failed because this sandbox could read the Codex auth but the app-server could not write its SQLite state there: `attempt to write a readonly database`.
- A second run with an empty writable `CODEX_HOME` failed with `401 Unauthorized`.
- The passing run used a writable temp Codex home seeded with `auth.json`, `config.toml`, and `installation_id` from the readable Codex home.
- OS-level process-count proof was not available: `pgrep` and `ps` were blocked in this sandbox. The process-sharing invariant is covered by `AppServerCodexBackend.test.ts`, which asserts two backends share one app-server client and route notifications by `threadId`.

## Final Retrospective

PASS. The Codex app-server path completed through F1 after providing a writable authenticated Codex home. The focused unit test covers the specific one-process/N-thread behavior that F1 cannot inspect in this sandbox.
