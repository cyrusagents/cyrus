# Test Drive: Atmiko rename and self-hosted runtime

**Date**: 2026-09-22
**Goal**: Validate the renamed CLI, workspace packages, local board, and issue/session pipeline after removing commercial onboarding and hosted defaults.
**Test repo**: `/private/tmp/f1-atmiko-rebrand-20260922`
**Runner**: Cursor, `composer-2`

## Verification results

### Issue tracker
- [x] F1 health and status endpoints responded on port 3600.
- [x] Created `issue-1` / `DEF-1`, titled `Atmiko renamed runtime smoke`.
- [x] Created and queried `session-1`.

### EdgeWorker
- [x] Created an isolated worktree under the temporary `atmiko-f1-*` home.
- [x] Routed `[agent=cursor] [model=composer-2]` to the requested runner.
- [x] Read README.md and returned the package name `simple-rate-limiter`.
- [x] Recorded nine activities, including the shell action and final response.
- [x] Stopped the session, saved state, and shut down the server gracefully.

### Renderer
- [x] Thought, action, and response activities have content and timestamps.
- [x] Pagination at offset 3 / limit 3 exactly matched the full activity slice.
- [x] Searching `simple-rate-limiter` returned the final response.
- [x] `/board` served the title `Atmiko · Tasks & Logs`.
- [x] `/board/api/snapshot` included the new task title.

## Session log

The server ran with a fresh temporary home and only the existing Cursor credential.
No production webhook integration or remote control-plane URL was loaded.

```sh
apps/f1/f1 init-test-repo --path /private/tmp/f1-atmiko-rebrand-20260922
ATMIKO_PORT=3600 apps/f1/f1 ping
ATMIKO_PORT=3600 apps/f1/f1 status
ATMIKO_PORT=3600 apps/f1/f1 create-issue --title 'Atmiko renamed runtime smoke' --description '[repo=f1-test-repo] [agent=cursor] [model=composer-2] Read-only validation: read README.md and answer with one short sentence naming the package. Do not edit files, commit, push, create PRs, or send messages.'
ATMIKO_PORT=3600 apps/f1/f1 start-session --issue-id issue-1
ATMIKO_PORT=3600 apps/f1/f1 view-session --session-id session-1 --limit 20 --offset 0
ATMIKO_PORT=3600 apps/f1/f1 stop-session --session-id session-1
```

The session ran from 08:58:12 to 08:58:32 UTC. JSON-RPC assertions verified
activity types, timestamps, pagination, and search. HTTP assertions verified
the board title and task snapshot. Shutdown completed at 09:01:28 UTC.

## Additional validation

- Clean build and monorepo typecheck passed.
- Package tests passed (2,022 tests, two skipped), followed by three new
  control-plane configuration regression tests.
- CLI tests passed (129 tests); F1 has no separate unit test files.
- A separate Cursor package checkout containing only the rename passed all 58 tests;
  pre-existing Grok model edits remain outside this commit.
- A local CLI tarball exposes the `atmiko` binary, resolves workspace dependency
  versions, and contains no obsolete branding or retired auth-key command.
- Installer tests passed (four tests, with `TMPDIR=/private/tmp` to avoid macOS
  `/var` versus `/private/var` alias differences).
- CLI help exposes `atmiko`, `--atmiko-home`, and direct authentication commands;
  the commercial auth-key command is absent.
- Lint passed with ten existing optional-chain warnings.
- Frozen-lockfile installation passed; npm's official audit endpoint reported
  zero known vulnerabilities. The configured mirror does not implement audit.
- Repository source, docs, tracked filenames, and skill links were checked for
  obsolete brand references and broken links.

## Retrospective

The runner's Read permission was rejected, so it used the permitted shell tool
to read README.md. F1 still displayed the session as active after the response;
completion was verified from the successful runner result and response activity,
then the session was explicitly stopped. Both behaviors also occurred in earlier
drives and were outside the rename scope. No live GitHub/Linear webhook was sent.
