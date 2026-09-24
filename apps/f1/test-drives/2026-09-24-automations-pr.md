# Automation PR validation

**Date:** 2026-09-24
**Branch:** `feat/automations`, based on `origin/main` (`4bdb18ea`)
**Test repository:** `/tmp/atmiko-automation-pr-f1-20260924`

## Isolation and checks

The PR was assembled in a clean worktree without the landing-page workspace,
its migration, or the unrelated Cursor runner changes. A clean build exposed a
logo import from that landing-page workspace; the asset now belongs to the board.
The board CSP explicitly permits its bundled data-URL font, with a regression
assertion that failed before the fix and passes afterward.

- Frozen-lockfile installation, full build and workspace typecheck passed.
- Full package suite: 2,060 passing tests, two skipped.
- CLI suite: 129 passing tests. F1 has no automated test files.
- Final edge-worker suite after the CSP fix: 977 passing tests, one skipped.
- Full lint passed with 10 existing warnings and no errors; changed-file checks passed.
- npm-registry dependency audit: no known vulnerabilities.

## F1 execution

1. Initialized the fresh repository using `apps/f1/f1 init-test-repo`.
2. Started the isolated F1 service on port 3600; `ping` and `status` passed.
3. Created `DEF-1` / `issue-1`, started `session-1`, and requested a read-only receipt.
   Four timestamped activities included routing, model selection and the final response.
   `view-session --limit 10 --offset 0` returned coherent paginated activity output.
4. Created a one-time direct automation through the board API, due ten seconds later.
   Run `fd268916-7da2-41a1-80e2-f2e0954231e8` created an isolated worktree,
   used the real Claude Sonnet runner, read the README, and reported its title.
   It finished as `succeeded` from a valid `no_change` outcome, with exactly one attempt.
   The board exposed tool, output, activity and lifecycle entries.
5. Verified create, resume, edit/pause, five-occurrence preview, archive and retained
   history through the local API using a separate definition that never executed.
6. Stopped `session-1` through F1, then shut down the isolated service cleanly.

## Limits

The fixture intentionally has no remote, so its expected fetch warning falls back
to local `main`; this drive does not create a remote PR. Earlier live Linear
delegation and desktop/mobile UI evidence is recorded in the September 23 reports.
Opening a new browser tab for the isolated board was blocked by the browser client
(`ERR_BLOCKED_BY_CLIENT`); no fresh screenshot acceptance is claimed for this drive.
Production schedules and external issues were not changed or executed.
