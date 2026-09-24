# Test Drive: automatic updates wait for real work

**Date**: 2026-09-24
**Base**: `6618e57a` (latest `mikoagents/miko` main when development began)
**Goal**: Verify the production update IPC protocol against a real F1 EdgeWorker and agent session.
**Test repo**: `/private/tmp/miko-update-f1-20260924` (fresh F1 repository, no remote)
**Port**: 3600; isolated F1 config home, no production service changes.

## Issue-tracker verification

- [x] `f1 init-test-repo`, `f1 ping`, and `f1 status` succeeded.
- [x] Created `issue-1` / `DEF-1`, explicitly routed with `[repo=f1-test-repo]`.
- [x] Started `session-1`; the task requested a read-only 20-second wait followed by reading README.md.
- [x] The real Claude runner produced `UPDATE_F1_OK` and a correct repository summary.

## Worker verification

- [x] F1 used the same `registerManagedUpdates` IPC controller as the production CLI.
- [x] While the agent executed `sleep 20`, `/status` returned `busy`.
- [x] The parent sent `miko:prepare-update`; the worker returned `accepted: false` and kept running.
- [x] The agent completed normally after the rejected restart request.
- [x] `/status` then returned `idle`; after `f1 stop-session`, the same request returned `accepted: true`.
- [x] The worker saved state and exited with code 0.
- [x] A second F1 process started with `MIKO_UPDATE_TRIAL=1`. It reported IPC readiness but returned HTTP 503 while task admission was paused.
- [x] `miko:activate-update` received `miko:activated`; `/status` returned HTTP 200 with `idle` afterwards.
- [x] The second process stopped cleanly. No unhandled application error was observed.

## Activity verification

- [x] `view-session --limit 10 --offset 0` returned seven timestamped activities.
- [x] Activities included routing/model thoughts, Bash/Read actions, and the final response.
- [x] The local board snapshot endpoint returned a valid snapshot with service state, tasks, and logs.
- [ ] Browser rendering and search were not exercised; this change adds no board UI.

## Protocol evidence

```text
miko:ready autoUpdate=true
miko:prepare-update during real task -> accepted=false
final response -> UPDATE_F1_OK
/status -> idle
miko:prepare-update after task -> accepted=true
worker exit -> 0

candidate trial: miko:ready
GET /status -> 503
miko:activate-update -> miko:activated
GET /status -> 200 {"status":"idle"}
```

## Additional validation

The Node installer/supervisor regression suite uses actual child processes and temporary release directories. It covers busy-to-idle activation, network/build failure, candidate startup failure and rollback, interrupted activation recovery, version pins, unchanged remote heads, cancellation, concurrent-install locks, and launcher argument forwarding. Skill tests cover unchanged/default updates, custom content/files/symlinks/deletions, legacy migration, and rollback.

F1 validates the real task admission and shutdown boundaries. The supervisor regression tests use a controlled remote/build adapter. The following separate live test validates GitHub fetching and pnpm builds.

## Live source-install upgrade

- [x] Installed published feature commit `57dd00db` from `https://github.com/mikoagents/miko.git` into a temporary install root, tracking `feat/automatic-updates`.
- [x] Started its installed launcher with an isolated config home on port 3610 using the default update timers.
- [x] Pushed `8712a65a` while the service was running. With no manual update request, the supervisor discovered it, fetched from GitHub, installed frozen dependencies, and built the candidate.
- [x] The idle worker saved state and exited cleanly. The candidate started, completed its 30-second probation, and became active.
- [x] `--installation` and `current.json` identified `8712a65a`; `previous.json` retained `57dd00db`. Update state reported `up-to-date` with no trial or error.
- [x] `/status` returned HTTP 200 and `idle`; `/board` and `/board/api/snapshot` also returned HTTP 200.
- [x] Stopped the isolated supervisor after verification. No production service was changed.

This live upgrade ran on macOS with Node 22.22.3 and pnpm 10.33.1. Windows was not live-tested.
