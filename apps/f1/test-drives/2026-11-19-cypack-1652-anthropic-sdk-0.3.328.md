# CYPACK-1652: Anthropic SDK 0.3.328 runtime verification

**Date:** 2026-11-19
**Goal:** Verify that Claude Code 2.1.328 initializes through Cyrus with the refreshed tool registry and preserves coherent F1 session activity.
**Test repository:** `/private/tmp/f1-cypack-1652-20261119`

## Scenario

F1 created a disposable repository and routed an inspection-only issue through the real `ClaudeRunner` query path. The prompt requested a repository read, a foreground `pwd` command with timeout `10000`, and the exact marker `SDK_RUNTIME_328_OK` without modifying files.

## Verification results

### Issue tracker

- [x] Server health and ready status returned successfully.
- [x] `issue-1` / `DEF-1` was created and exposed through the CLI tracker.
- [x] Repository selection accepted `F1 Test Repository` and resumed the pending session.

### EdgeWorker and Claude runtime

- [x] EdgeWorker created the `DEF-1` worktree from local `main`.
- [x] Claude Code 2.1.328 initialized through `@anthropic-ai/claude-agent-sdk` 0.3.328.
- [x] Cyrus supplied its 33-tool engineering catalog, including `WebFetch` and the three resource-discovery tools.
- [x] The session used the hardened shell-startup environment and top-level MCP configuration carried forward from the 0.3.323-0.3.327 compatibility work.
- [ ] Repository `Read`, foreground `Bash(pwd)`, and the exact final marker did not run because the host's stored Claude OAuth token has expired.

### Activity rendering

- [x] Elicitation, prompt, acknowledgment, routing, model, and authentication-error activities rendered coherently.
- [x] Pagination returned the requested three-activity window.
- [x] Search returned the Claude model activity.
- [x] The session stop request was accepted and the F1 server shut down cleanly.

## Supporting checks

- `./scripts/extract-claude-tools.sh` completed against Claude Code 2.1.328 with 26 clean built-ins and exactly three resource-capability additions: `ListMcpResourcesTool`, `ReadMcpResourceDirTool`, and `ReadMcpResourceTool`.
- The extracted catalog is unchanged from 2.1.327. Cyrus intentionally retains four context-dependent capabilities beyond the 29-tool fixture: `PushNotification`, `LSP`, `RemoteTrigger`, and `DesignSync`.
- `pnpm build`, `pnpm typecheck`, package tests, lint, and `pnpm audit` passed before the drive. Lint reported only existing warnings.

## Disposition

Runtime initialization, tool-catalog construction, worktree creation, activity delivery, pagination, search, and shutdown are verified. The installed repository-tool receipt remains blocked by expired host authentication; no credential mutation or alternate account was used.
