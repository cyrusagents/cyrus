# Test Drive: CYPACK-1197 — autoMemoryDirectory in chat allowedDirectories

**Date**: 2026-05-13
**Goal**: Verify that the shared auto-memory directory is now included in `allowedDirectories` for Slack chat sessions and is no longer covered by the home-directory `Read(...)` deny rule.
**Test Repo**: `/tmp/f1-test-drive-1778699666`
**F1 cyrusHome**: `/tmp/cyrus-f1-1778699670468`

## Verification Results

### EdgeWorker — chat config assembly

- [x] `allowedDirectories` contains the auto-memory directory.
- [x] `allowedTools` now includes an explicit `Read(//<auto-memory>/**)` entry (derived from the SDK `--add-dir` plumbing).
- [x] `settings.autoMemoryDirectory` is forwarded to the SDK with the same path.

Telemetry from `[event:claude_query_options]` after dispatching a synthetic Slack `app_mention`:

```
cqo.allowedDirectoryCount: 3
cqo.allowedToolsPreview:
  ...
  Read(//tmp/cyrus-f1-1778699670468/slack-workspaces/C_TEST_CYPACK1197_1778699684.723/**)
  Read(//tmp/cyrus-f1-1778699670468/slack-memory/**)
  Read(//tmp/f1-test-drive-1778699666/**)
cqo.settingsAutoMemoryDirectory: /tmp/cyrus-f1-1778699670468/slack-memory
```

Full chat config dump from `EdgeWorker` debug log:

```
allowedDirectories: [
  "/tmp/cyrus-f1-1778699670468/slack-workspaces/C_TEST_CYPACK1197_1778699684.723",
  "/tmp/cyrus-f1-1778699670468/slack-memory",
  "/tmp/f1-test-drive-1778699666"
]
settings: {
  autoMemoryDirectory: "/tmp/cyrus-f1-1778699670468/slack-memory"
}
```

### Home-directory deny rule — before/after comparison

F1 uses `/tmp/cyrus-f1-*` as `cyrusHome`, which is **outside** the user home directory, so `buildHomeDirectoryDisallowedTools` returns `[]` in F1 and does not exercise the original bug. To validate the actual fix, the helper was invoked directly with real home-directory paths simulating the production case (`cyrusHome = ~/.cyrus`):

```js
const workspace   = "~/.cyrus/slack-workspaces/thread-x";
const slackMemory = "~/.cyrus/slack-memory";
const repoPath    = "/tmp/some-repo";

// BEFORE — allowedDirectories = [workspace, repoPath]
buildHomeDirectoryDisallowedTools(workspace, [workspace, repoPath])
  .filter(p => p.includes("slack-memory"))
// → ["Read(//Users/agentops/.cyrus/slack-memory/**)"]   ← bug

// AFTER — allowedDirectories = [workspace, slackMemory, repoPath]
buildHomeDirectoryDisallowedTools(workspace, [workspace, slackMemory, repoPath])
  .filter(p => p.includes("slack-memory"))
// → []   ← fixed
```

This is the deterministic proof that the fix removes the `Read(.../slack-memory/**)` deny rule that was blocking the session from reading or editing existing memory files.

### Workspace isolation alongside shared memory

- [x] Per-thread workspace exists at `/tmp/cyrus-f1-1778699670468/slack-workspaces/C_TEST_CYPACK1197_1778699684.723/` (sanitized thread key, isolated).
- [x] Shared memory directory exists at `/tmp/cyrus-f1-1778699670468/slack-memory/` (single dir, not per-thread).

## Session Log

```
$ ./f1 init-test-repo --path /tmp/f1-test-drive-1778699666
✓ Test repository created

$ CYRUS_PORT=3600 CYRUS_REPO_PATH=/tmp/f1-test-drive-1778699666 \
    bun run apps/f1/server.ts &
$ CYRUS_PORT=3600 ./f1 ping
✓ Server is healthy

$ CYRUS_PORT=3600 ./f1 start-chat-session \
    --channel C_TEST_CYPACK1197 \
    --user U_TEST \
    --text "..."
✓ Chat event dispatched
  Event ID: f1-1778699684.723
  Thread Key: C_TEST_CYPACK1197:1778699684.723

$ CYRUS_PORT=3600 ./f1 list-chat-threads
✓ Found 1 chat thread(s):
  C_TEST_CYPACK1197:1778699684.723: slack-f1-1778699684.723
```

The session itself errored out at the Claude CLI level (`Not logged in · Please run /login`) because the F1 environment does not have Claude credentials wired up. This is irrelevant to the validation, which targets the runner config assembly (verified via `[event:claude_query_options]` telemetry) and the deny-rule helper (verified out-of-band).

## Final Retrospective

What worked:
- The F1 `start-chat-session` endpoint cleanly exercises the chat-config path end-to-end, and the structured `claude_query_options` telemetry made it trivial to inspect the resolved runner config.
- The direct invocation of `buildHomeDirectoryDisallowedTools` with home-directory paths conclusively shows the deny rule no longer covers the auto-memory directory.

Gaps:
- F1's `/tmp`-based `cyrusHome` means the home-directory deny rule never fires inside F1 itself; the regression-relevant assertion has to be made out-of-band. Worth considering whether F1 should optionally allow a home-directory-relative `cyrusHome` for tests like this, or whether the unit test in `packages/edge-worker/test/RunnerConfigBuilder.chat-config.test.ts` (added in this PR) plus the direct helper invocation above are sufficient coverage.

Outcome: **Pass.** All three acceptance criteria from the issue that are testable without a live Claude login are confirmed:
- `Read` and `Glob` over the auto-memory directory will no longer be denied by the home-dir helper.
- `Edit`/`Write` to existing `MEMORY.md` becomes possible transitively (the prior-read prerequisite no longer fails).
- Existing chat-session permission tests still pass; a new test asserts `allowedDirectories` includes the auto-memory directory.
