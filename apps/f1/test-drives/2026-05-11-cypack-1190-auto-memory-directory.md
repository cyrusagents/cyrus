# Test Drive: CYPACK-1190 — autoMemoryDirectory for Slack chat sessions

**Date**: 2026-05-11
**Goal**: Verify the new Claude Code SDK `settings.autoMemoryDirectory` setting is threaded through `ClaudeRunner` for Slack-triggered chat sessions and is shared across all Slack threads (one auto-memory dir per platform, not per thread).
**Test Repo**: `/tmp/cypack-1190-test` (minimal init repo)
**Cyrus Home**: `/tmp/cyrus-f1-1778544835252`
**F1 Port**: 3699

## Verification Results

### Chat dispatch endpoint (F1-only)
- [x] `POST /cli/dispatch-chat` returns `{ ok: true, eventId, threadKey }`
- [x] Route registered before `edgeWorker.start()` (Fastify rejects post-listen routes)
- [x] `dispatchChatTestEvent` reaches `ChatSessionHandler.handleEvent`

### autoMemoryDirectory wiring
- [x] `AgentRunnerConfig.autoMemoryDirectory` field added in `packages/core/src/agent-runner-types.ts`
- [x] `ClaudeRunnerConfig.autoMemoryDirectory` field added in `packages/claude-runner/src/types.ts`
- [x] `ClaudeRunner` forwards `settings: { autoMemoryDirectory }` to SDK `query()` options
- [x] `RunnerConfigBuilder.buildChatConfig` defaults to `<cyrusHome>/<platformName>-memory` for chat sessions
- [x] `ChatSessionHandler` forwards `adapter.platformName` into `buildChatConfig`
- [x] `buildSanitizedQueryOptions` surfaces `settingsAutoMemoryDirectory` so the `claude_query_options` telemetry event includes it

### Cross-thread sharing
- [x] First dispatch to `C_TEST1` resolved memory dir to `/tmp/cyrus-f1-1778544835252/slack-memory`
- [x] Second dispatch to a different channel `C_TEST2` resolved to the **same** `slack-memory` dir
- [x] Single `slack-memory/` directory exists under `cyrusHome` (no per-thread subdirs)
- [x] Per-thread workspaces remain isolated under `slack-workspaces/<thread-key>/`; only the memory dir is shared

## Session Log

### Setup
```
$ mkdir /tmp/cypack-1190-test && cd /tmp/cypack-1190-test
$ git init -q && touch README.md && git add . && git commit -m init -q
$ CYRUS_PORT=3699 CYRUS_REPO_PATH=/tmp/cypack-1190-test bun run apps/f1/server.ts &
```

### Dispatches
```
$ curl -s -X POST http://localhost:3699/cli/dispatch-chat -d '{"channel":"C_TEST1","user":"U1","text":"first"}'
{"ok":true,"eventId":"f1-1778544840.941","threadKey":"C_TEST1:1778544840.941"}

$ curl -s -X POST http://localhost:3699/cli/dispatch-chat -d '{"channel":"C_TEST2","user":"U2","text":"second"}'
{"ok":true,"eventId":"f1-1778544842.997","threadKey":"C_TEST2:1778544842.997"}
```

### cyrusHome layout
```
$ ls /tmp/cyrus-f1-1778544835252/
cyrus-skills-plugin
logs
mcp-configs
repos
slack-memory          <-- shared across all Slack threads
slack-workspaces      <-- per-thread workspaces (still isolated)
state
worktrees
```

### Telemetry (claude_query_options)
```
cqo.settingsAutoMemoryDirectory=/tmp/cyrus-f1-1778544835252/slack-memory
cqo.settingsAutoMemoryDirectory=/tmp/cyrus-f1-1778544835252/slack-memory
```
Same path emitted for both threads — confirms cross-thread sharing.

## Final Retrospective

What worked:
- Threading `adapter.platformName` from `ChatSessionHandler` into `buildChatConfig` cleanly resolves the shared-memory path without touching the per-thread workspace layout.
- `SlackChatAdapter`'s no-token bailout still allows synthetic F1 dispatches.
- The `cqo.settingsAutoMemoryDirectory` telemetry attribute made it easy to confirm both dispatches resolved to the same memory path.

Initial design adjusted:
- The first cut namespaced the memory dir per-thread (`<workspacePath>/memory`). User feedback clarified that memory should be shared across all Slack threads, not isolated per thread. Reworked to `<cyrusHome>/<platformName>-memory`.

Notes:
- Per-thread workspaces (`slack-workspaces/<thread-key>/`) remain isolated — only the auto-memory dir is shared.
- Future chat platforms (e.g. GitHub chat, Linear chat) get their own shared memory dir automatically via the platformName namespace.

---

## Addendum — 2026-05-12: Live cross-thread memory recall (real ClaudeRunner)

**Goal:** verify Claude actually *uses* `slack-memory/` — write a fact in one Slack thread, read it back in a separate thread.

**Setup:** F1 server on port 3600 (`CYRUS_HOME=/tmp/cyrus-f1-1778614539137`), `CLAUDE_CODE_OAUTH_TOKEN` provided so real Claude sessions run.

**Thread A (`C_THREAD_A:1778614548.306`)** — dispatched:
> "Please commit the following to your auto-memory so a different future session can recall it: my favorite color is octarine and my secret codeword is BANANAPHONE-42 …"

Reply:
> Stored to auto-memory:
> - Favorite color: octarine
> - Secret codeword: BANANAPHONE-42
> Both are saved in `user_preferences.md` and indexed in `MEMORY.md` so future sessions can recall them.

Filesystem after Thread A:

```
/tmp/cyrus-f1-1778614539137/slack-memory/
├── MEMORY.md
└── user_preferences.md       (originSessionId: e0cfbfb6-…)
```

**Thread B (`C_THREAD_B:1778614685.206`, different channel + user)** — dispatched:
> "Quick question: do you happen to know my favorite color or any secret codeword I shared with you previously? Please check your auto-memory before saying you don't know."

Reply:
> Yes! From my memory:
> - Favorite color: octarine
> - Secret codeword: BANANAPHONE-42

**Telemetry:** both sessions emitted `cqo.settingsAutoMemoryDirectory=/tmp/cyrus-f1-1778614539137/slack-memory` while running with distinct cwds:
- Thread A cwd: `…/slack-workspaces/C_THREAD_A_1778614548.306`
- Thread B cwd: `…/slack-workspaces/C_THREAD_B_1778614685.206`

**Workspace isolation:** `slack-workspaces/` contains separate per-thread directories; only `slack-memory/` is shared.

**Verdict:** ✅ End-to-end cross-thread memory recall works. Thread A's writes (via Claude's auto-memory mechanism) were durably persisted to the shared `slack-memory/` directory and successfully retrieved by Thread B's independent ClaudeRunner session.
