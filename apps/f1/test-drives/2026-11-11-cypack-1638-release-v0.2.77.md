# Release v0.2.77: runtime verification

**Date:** 2026-11-11
**Issue:** [CYPACK-1638](https://linear.app/ceedar/issue/CYPACK-1638)
**Tested source:** `bf0f56e62ac50dc94f52383059fd8e1790d258f0`; the only uncommitted changes in the worktree are the two changelog-section moves (`CHANGELOG.md`, `CHANGELOG.internal.md`) that promote the `[Unreleased]` entries into a `[0.2.77]` section — no source files were modified.
**Previous published release:** `v0.2.76`
**Result:** PASS for the release checks described below. This does not assert npm publication; that remains a separate gate.

## Full-payload assessment

Three PRs merged since v0.2.76 (`git log v0.2.76..HEAD`):

- **#1588, feat(slack): apply userAccessControl to Slack sessions** — gates who can start/continue a Slack session via the existing `userAccessControl` allow/block lists, extended with a `{ slackId }` identifier. This is a Slack-only behavior change (`ChatSessionHandler`); it does not touch the Linear/CLI/F1 session-tracker, routing, or runner-selection paths that F1 exercises. Not F1-covered; validated by its own unit tests (part of the `edge-worker` 915-passing suite below, which includes the Slack access-control coverage).
- **#1589, chore(deps): update Anthropic SDKs** — bumps `@anthropic-ai/claude-agent-sdk` `0.3.318` → `0.3.322` (Claude Code `2.1.318` → `2.1.322`) and `@anthropic-ai/sdk` `^1.5.0` → `^1.7.0` in `packages/claude-runner`, `packages/core`, `packages/edge-worker`, and `packages/simple-agent-runner`. This is a Claude runtime change exercised directly by F1 (session init, tool execution, continuity) — **this is the drive's focus**.
- **#1591, Allow selected GitHub App review feedback per organization** — adds per-organization opt-in for GitHub App automated review comments (`EdgeConfig` schema additions, `WorkerService` test coverage, a GitHub-webhook-path review script). This is exercised through the GitHub webhook/review path, not the F1 CLI issue-tracker/session lifecycle. Not F1-covered; validated by its own unit tests.

This is a runtime-bearing payload because of #1589; F1 was run against the updated SDK per the applicability policy. #1588 and #1591 are out of scope for F1 and are covered by their package unit tests (counted in "Other checks" below).

## Test environment

Reused the known v0.2.76 gotcha workaround: the agent sandbox blocks transcript writes under the default Claude config directory, which breaks session resume/continuity checks. Per-process environment (not persisted host configuration), preserving the existing keychain identity:

```sh
CLAUDE_CONFIG_DIR=/private/tmp/cypack-1638-claude-config
CLAUDE_SECURESTORAGE_CONFIG_DIR=''
CYRUS_PORT=3638
CYRUS_REPO_PATH=/tmp/f1-cypack-1638-repo
```

F1 test repo scaffolded fresh via `./f1 init-test-repo --path /tmp/f1-cypack-1638-repo`. Unmodified `apps/f1/server.ts` was used (no temporary routes added — this drive did not need warm-session RPCs). Confirmed the SDK's bundled Claude Code binary ahead of the drive:

```sh
node_modules/.pnpm/@anthropic-ai+claude-agent-sdk-darwin-arm64@0.3.322/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude --version
# 2.1.322 (Claude Code)
```

## Live F1 results

1. Started the F1 server on port 3638; `./f1 ping` and `./f1 status` returned healthy/ready.
2. Created `DEF-1` with `[repo=f1-test-repo]` in the description, instructing the agent (in order) to: Read `package.json`, run a foreground `Bash(pwd)`, remember the marker `ORCHID_1638`, and reply with the exact text `SDK_RUNTIME_OK`.
3. Started `session-1`. Description-tag routing selected the F1 test repository and created the worktree at `DEF-1`. The SDK's `system/init` message reported `"claude_code_version":"2.1.322"` (model `claude-sonnet-5-5`, permission mode `default`). The activity timeline showed, in order: two routing/thought activities, a `Read` action (`/private/tmp/f1-cypack-1638-repo/package.json`), a `Bash (Print working directory)` action, and the final `response` activity with the exact text **`SDK_RUNTIME_OK`**. The `result` SDK message had `"is_error":false`, `"subtype":"success"`, `"result":"SDK_RUNTIME_OK"`. Claude session ID: **`df88a228-d85b-4bb4-9bc8-e79682949835`**.
4. Prompted the same session: "What was the marker I asked you to remember earlier? Reply with only that exact marker, nothing else." The session resumed on the **same** Claude session ID `df88a228-d85b-4bb4-9bc8-e79682949835` (confirmed via `event:claude_session_id_assigned` in the server log) and the new `response` activity was the exact text **`ORCHID_1638`**. No `session_writes_lost` event appeared anywhere in the server log for this drive.
5. Stopped `session-1` (`./f1 stop-session` returned success) and killed the F1 server process. Confirmed clean shutdown: a subsequent `./f1 ping` and a direct `curl` to the server port both failed to connect.

This confirms, for Claude Code 2.1.322 / `@anthropic-ai/sdk` 1.7.0: SDK init reporting, tool execution (Read + foreground Bash) visible in the activity timeline, exact final-response posting, and session continuity across a follow-up prompt with no write-loss.

## Other checks

- `pnpm install --frozen-lockfile`: passed; lockfile unchanged.
- `pnpm build`, `pnpm typecheck`, `pnpm test:packages:run`: all passed. Package test counts: `edge-worker` 915 passed / 1 skipped, `claude-runner` 150 passed, `github-event-transport` 127 passed, `slack-event-transport` 82 passed, `core` 206 passed, `mcp-tools` 35 passed, `cloudflare-tunnel-client` 45 passed, `config-updater` 76 passed, `gitlab-event-transport` 11 passed, `linear-event-transport` 31 passed, `plane-event-transport` 29 passed, `zulip-event-transport` 25 passed, `simple-agent-runner` 24 passed, `cursor-runner` 45 passed, `codex-runner` 72 passed, `gemini-runner` 198 passed / 1 skipped, `opencode-runner` 32 passed.
- `pnpm --filter cyrus-ai test:run`: 162 passed.
- `pnpm lint`: passed with 14 existing warnings (unchanged from prior releases; all `useOptionalChain` suggestions in `simple-agent-runner`/`claude-runner`, not newly introduced).
- `pnpm audit --audit-level low`: zero advisories.
- `git status`/`git diff --stat` at the tested commit: only `CHANGELOG.md` (+58/-0) and `CHANGELOG.internal.md` (+2/-0) changed, both moving `[Unreleased]` entries into a new `[0.2.77]` section — no source files touched.

## Final retrospective

The focused change (#1589, Anthropic SDK bump to Claude Code 2.1.322 / API SDK 1.7.0) was validated end-to-end through F1: cold session start, SDK init version reporting, real tool execution (Read, foreground Bash) visible as timeline activities, exact final-response posting, and session continuity (same Claude session ID across a follow-up prompt, no `session_writes_lost`). The previously known config-dir sandbox gotcha from the v0.2.76 drive recurred as expected and was avoided with the same per-process `CLAUDE_CONFIG_DIR` / `CLAUDE_SECURESTORAGE_CONFIG_DIR` workaround — no new issues were found with that workaround on this release. The other two merged PRs (#1588 Slack access control, #1591 GitHub App per-org review opt-in) are outside F1's CLI/Linear session-tracker scope and were left to their own unit tests, which passed. No failures or blockers were encountered in this drive.
