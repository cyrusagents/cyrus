# Test Drive: Integrated local status board

**Date:** 2026-09-16

**Goal:** Verify that the real EdgeWorker serves `/board` alongside `/status` and reports live runner activity without a separate monitor process.

**Environment:** Windows, Node 24.9.0, Bun 1.2.23; disposable F1 repository and port 3600. The existing production instance was left running.

## Verification results

### Issue tracker and EdgeWorker

- [x] Built the monorepo and initialized a fresh repository with the built F1 CLI.
- [x] Started `apps/f1/server.ts` with `CYRUS_DEFAULT_RUNNER=codex` and `CODEX_MODEL=gpt-6-astra`.
- [x] F1 `ping` and `status` succeeded.
- [x] Created `DEF-2` with label `primary`; repository label routing selected the test repository.
- [x] Started `session-2`; Cyrus created its worktree and ran Codex.
- [x] The read-only task inspected README.md and returned the requested phrase, without changing files or creating a commit/PR.
- [x] `view-session --session-id session-2 --limit 3 --offset 1` returned three of six activities with timestamps and readable content.
- [x] Both test sessions stopped successfully, the disposable server was terminated, and the test repository remained clean.

The initial unlabeled issue correctly requested repository selection and never appeared as a running task. The second issue used the harness's documented routing label.

### Board data and rendering

- [x] `/board`, its bundled assets, and `/board/api/snapshot` are served by the same application server as `/status`.
- [x] During execution, the snapshot reported `service.status=busy`, task `status=running`, the selected repository and model, and assistant/tool/result output.
- [x] After completion, the same task reported `status=completed` while the service reported `idle`. The result contained “Board integration verified”. The CLI issue session remained active, confirming the board did not mistake persisted session status for runner activity.
- [x] Automated tests verify initial and subsequent SSE frames, stream shutdown, loopback restrictions on every board route, unchanged `/status`, output allowlisting, redaction, and live-runner prioritization.
- [x] React LogViewer adapter tests verify empty matching-line results and navigation using filtered row positions.
- [x] Package dry-run includes HTML, JS, CSS, dependency notices, and the React LogViewer license under `dist/board/`.
- [ ] Visual browser verification: Edge returned `ERR_BLOCKED_BY_CLIENT` for both localhost and 127.0.0.1 on the test port. Browser protections were left unchanged. HTTP and component checks passed, but this run does not claim a visual browser pass.

## Commands and results

Use `bun run apps/f1/dist/src/cli.js` for the built F1 CLI on Windows. Its source entry point resolves package.json relative to the compiled directory layout.

```sh
pnpm build
pnpm typecheck
pnpm --filter cyrus-core test:run test/log-publisher.test.ts
pnpm --filter cyrus-edge-worker test:run test/StatusBoard.test.ts test/BoardViewer.test.ts
pnpm -r --no-bail --filter './packages/*' test:run
pnpm audit --registry=https://registry.npmjs.org
```

- Full build and typecheck: pass.
- New tests: 15/15 pass.
- Changed source files: Biome check passes.
- Dependency audit: zero advisories. React LogViewer pins Immutable 5.1.5; a scoped override uses the patched 5.1.9 release.
- Full package suite: 125 failures on this Windows host. A separate checkout of unchanged base `e9e1e53` reproduces exactly the same 125 failing test names; no new failures. Examples include POSIX permission bits, slash-sensitive paths, and shell mocks.
- Full lint: the checkout has CRLF formatting failures and existing warnings. Baseline: 489 errors / 12 warnings; this branch: 482 errors / 12 warnings. Unrelated files were not reformatted.

## Retrospective

The existing server can provide a useful live view directly from its owned runners and structured logger. No process scanning, credentials/config serialization, standalone listener, or production restart was needed. Remaining validation limitations are the baseline Windows checks and the blocked Edge visual check described above.

## History regression follow-up

A resumed runner has a new message buffer even though the session manager still retains previous turns. The original board only read saved entries when there was no runner, so resuming a session hid its history. Two regression tests reproduced this omission and the loss of saved timestamps before the fix.

The board now merges saved public output with the runner buffer and suppresses overlapping entries by runner session ID, output kind and content, preserving occurrence counts and saved timestamps. Saved tool results are included; plain user prompts remain excluded. This also restores tool names in historical output.

Validation: all 17 board/logger tests pass; full build and typecheck pass. The worker suite has 807 passing tests, one skip, and the same 52 Windows failures present in the base commit, with no new failures. A local saved-state check confirmed that history remains visible even with an empty replacement runner. This fixes retained history visibility; it does not restore tasks previously deleted by session cleanup.

## Task archive follow-up

The left task list still lost completed issues because terminal-state cleanup removes both the session and its entries. A regression test reproduced the empty task list after `removeSession`, independently of whether the page had ever been opened.

The session manager now emits a removal event before deleting entries, including age-based cleanup. The board captures allowlisted task metadata and recent public output, then saves an atomic, bounded archive under the configured Cyrus home. Archived rows and per-task log retrieval survive restart; live sessions override an archive with the same ID. Archive errors do not interrupt task cleanup. Other runners retain their observed start times when a task is archived.

An additional F1 drive used a fresh disposable repository on port 3600 and a real Codex runner. The labeled issue `DEF-1` read README.md and returned `Archive lifecycle verified.` Six tracker activities were verified with pagination. `terminate-issue --issue-id issue-1 --action completed` then ran actual terminal cleanup. The first board request was made only after cleanup: it returned the task with `archived=true`, `status=completed`, and five archived agent entries including the final result. The repository remained clean and the test server was stopped.

Validation: 22 board/history/viewer/logger tests pass, including restart, ID deduplication, age-based cleanup, retention limits, redaction, corrupt/unwritable storage, and history-route access control. Full monorepo build and typecheck pass. The worker suite has 812 passing tests, one skip, and the same 52 baseline Windows failures; changed-file Biome checks pass.

The updated local service was also verified in the user's existing Edge tab: both a retained task and an archived task appeared, and selecting the archive loaded its individual log entries. This supersedes the earlier blocked browser check for the local installation. Historical data recovered for that installation was kept outside the repository; automatic recovery of tasks deleted before this archive existed is not claimed.

## Fork installer follow-up

The setup skills previously installed the official npm package, so changing only the skill repository could not reproduce this fork's board. The prerequisites skill now bundles a Node installer and launcher. The tested runtime pin is `11a7f23bf8c71c72409bd39477979623a1e175d5`; this is independent of the setup skills' own revision. Authentication, repository commands and service examples use the verified launcher.

Validation on Windows / Node 24.9.0:

- A fresh installation directory containing a space was populated by fetching the pinned commit from GitHub, installing its frozen lockfile using pnpm 10.33.1, and building the CLI dependency graph. No global Cyrus artifacts were copied into it.
- `--installation` reported the expected repository and commit, with worker/core resolving to the source workspace packages. The launcher passed through ordinary CLI options and `--version`.
- The launcher started an actual worker on isolated port 3600 with an empty, separate Cyrus home. `/status`, `/board` and `/board/api/snapshot` succeeded. A console interrupt ran normal state persistence and server shutdown. The production worker on 3456 was not restarted.
- Reinstalling the immutable pin reused the verified build. A real fetch of a nonexistent ref failed without changing `current.json`.
- Four Node tests passed: CLI argument forwarding, rejection of an in-tree published-package substitute, missing assets/path escapes, and preservation of the selected runtime on invalid input or concurrent installation. Five modified skills passed the skill validator; installer files passed Biome. Existing board/history/viewer tests remained 20/20 passing.
- After the launcher smoke test stopped, F1's additional development dependencies were installed in the disposable source release. A real Codex task read README.md and returned `Fresh fork verified.` Its six activities were checked with pagination. Terminal cleanup retained an archived completed task with five log entries and the final result. The test repository stayed clean.

The installer has explicit macOS/Linux execution paths, but this host only exercised Windows. It retains prior release directories and does not automatically migrate existing service commands; the launch skill performs that switch when the worker is idle.

The distribution path was also exercised with skills 1.5.26: installing `nexmoe/cyrus#feat/integrated-status-board` into a disposable project downloaded all five changed skills, including the installer, launcher and source pin. The downloaded installer verified the existing smoke installation successfully. The README uses this tested `#ref` syntax because a GitHub `/tree/` URL incorrectly split the slash-containing branch name.

## Compact activity UI follow-up

The default log view now uses single-line, color-coded activity rows with expandable details, paired tool input/results, error highlighting, full-text search and a three-lane event strip. The Raw view retains the bundled React LogViewer. Pairing requires an opaque ID derived from the runner session and tool call, plus the same Cyrus task; older unlinked archives remain readable as separate rows. Empty tool results are retained. Statistics describe only the loaded log window, and strip markers represent event order rather than execution duration.

A fresh disposable F1 repository on port 3600 ran a real Codex task that read README.md and returned `Activity pairing verified.` The tracker recorded six activities; pagination returned three entries at offset one. The board exposed two assistant entries, one tool call, one tool result and one completion entry. After terminal cleanup, the archived task was completed and its five entries projected into four rows with one correctly paired tool/result. The repository stayed clean and the idle test server was stopped.

Validation: full monorepo build and typecheck passed. All 26 worker board/history/viewer/activity tests passed. The full worker suite has 818 passing tests, one skip and exactly the same 52 failing test names as the established Windows baseline. Changed-file Biome checks passed. The existing two local tasks survived the production update, and public agent entries now include correlation IDs. The existing local webhook patch was preserved by hash.

Visual verification for this UI revision could not be completed: claiming the existing Edge tab timed out, and a fresh Edge tab reported `ERR_BLOCKED_BY_CLIENT` for the local URL. Browser protections were not changed. HTTP, build, data projection and real-runner validation passed; this follow-up does not claim a browser interaction or screenshot pass.

The setup pin was advanced to activity runtime commit b5df78c8aef9f1072f382df8c945f2be2d7d4ab6. The bundled installer fetched and built that revision in an isolated directory, and its board JavaScript hash matches the deployed local build. All four installer regression tests still pass.

