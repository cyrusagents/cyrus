# Test Drive: GPT-6 Astra through Codex 0.153.3

**Date**: 2026-09-04
**Goal**: Validate that the upgraded bundled Codex runtime can select and run `gpt-6-astra` through the F1 issue, EdgeWorker, Codex app-server, and activity-rendering pipeline.
**Test Repo**: `/private/tmp/cypack-1494-f1-gpt6-20260904-1606`

## Verification Results

### Issue-Tracker
- [x] Issue created
- [x] Issue ID returned (`issue-1`, `DEF-1`)
- [x] Issue metadata accessible

### EdgeWorker
- [x] Session started (`session-1`)
- [x] Worktree created
- [x] Activities tracked
- [x] GPT-6 Astra produced a response
- [ ] Local command execution completed (blocked by the nested macOS sandbox restriction described below)

### Renderer
- [x] Activity format correct (`thought`, `action`, and `response`)
- [x] Timestamps present
- [x] Pagination works (`--limit 3 --offset 3`)
- [x] Search works (`--search "GPT-6"` and `--search "incomplete"`)

## Session Log

1. Built the F1 application and all transitive workspace packages:

   ```text
   pnpm --filter cyrus-f1... build
   Scope: 16 of 18 workspace projects
   apps/f1 build: Done
   ```

2. Confirmed the upgraded runtime installed by the Codex runner:

   ```text
   codex-cli 0.153.3
   @openai/codex-sdk 0.153.3
   ```

3. Initialized a fresh F1 repository and started the server with the Codex runner and GPT-6 Astra selected:

   ```text
   ./apps/f1/f1 init-test-repo --path /private/tmp/cypack-1494-f1-gpt6-20260904-1606
   CODEX_HOME=/private/tmp/cypack-1494-codex-home \
     CYRUS_PORT=3600 \
     CYRUS_REPO_PATH=/private/tmp/cypack-1494-f1-gpt6-20260904-1606 \
     CYRUS_DEFAULT_RUNNER=codex \
     CODEX_MODEL=gpt-6-astra \
     bun run apps/f1/server.ts
   ```

4. Verified server health and created a label-routed Codex issue with `[model=gpt-6-astra]`. The session activity confirmed:

   ```text
   Using model: codex/gpt-6-astra
   ```

5. GPT-6 Astra initialized successfully, emitted coherent thought and MCP action activities, and returned a final response. The session was then stopped and the F1 server shut down cleanly.

6. Verified renderer pagination and search:

   ```text
   ./apps/f1/f1 view-session --session-id session-1 --limit 3 --offset 3
   ./apps/f1/f1 view-session --session-id session-1 --search "GPT-6"
   ./apps/f1/f1 view-session --session-id session-1 --search "incomplete"
   ```

## Blockers

The managed agent environment does not permit Codex to initialize its SQLite state under the normal `~/.codex` path. Pointing `CODEX_HOME` at an isolated writable temporary directory resolved app-server startup while preserving the existing ChatGPT login.

After startup, nested local command execution was blocked by the outer managed sandbox:

```text
sandbox-exec: sandbox_apply: Operation not permitted
```

This prevented the F1 agent from reading the test repository through its shell tools. It did not prevent the upgraded Codex app-server from starting, selecting `gpt-6-astra`, performing inference, emitting activities, or returning a response. A fully unrestricted command/edit test must run outside the current nested macOS sandbox.

## Final Retrospective

The GPT-6-specific path passed: Cyrus routed the issue to Codex, launched bundled Codex 0.153.3, selected `gpt-6-astra`, streamed coherent activity, and received a successful model response. The only incomplete portion is file/command tool execution, which is blocked by the test host's nested sandbox rather than by the Codex upgrade or model selection.
