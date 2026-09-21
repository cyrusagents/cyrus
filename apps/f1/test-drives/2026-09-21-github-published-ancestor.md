# Test Drive: Reviewing an already-published ancestor

**Date**: 2026-09-21
**Goal**: Validate session execution alongside the shipping-guardrail correction for a PR branch that advances during review.
**Test repo**: `/private/tmp/f1-github-published-ancestor-20260921`
**Runner**: Cursor, `composer-2`

## Verification results

### Issue tracker
- [x] Created local issue `issue-1` / `DEF-1` with its title and URL.
- [x] Started and inspected session `session-1`.

### EdgeWorker
- [x] Created an isolated worktree from local `main`.
- [x] Read README.md and returned `simple-rate-limiter` in one final response.
- [x] Recorded seven activities, including the shell read and final response.
- [x] Stopped the session and shut down the server gracefully, with no unhandled errors.

### Renderer
- [x] Thought, action and response activities have readable content and timestamps.
- [x] `--limit 2 --offset 5` returned exactly the last two of seven activities.
- [ ] Activity search was not exercised.

## Session log

The changed EdgeWorker was built before starting F1 on port 3600 with a fresh temporary Cyrus home. Only the configured Cursor credential was loaded; production webhook integrations were not used.

```sh
apps/f1/f1 init-test-repo --path /private/tmp/f1-github-published-ancestor-20260921
CYRUS_PORT=3600 apps/f1/f1 ping
CYRUS_PORT=3600 apps/f1/f1 status
CYRUS_PORT=3600 apps/f1/f1 create-issue --title 'Validate published-ancestor guardrail runtime' --description 'Read-only F1 validation. [repo=f1-test-repo] [agent=cursor] Read README.md and return one short sentence with the package name. Do not edit files, commit, push, create pull requests, or send messages.'
CYRUS_PORT=3600 apps/f1/f1 start-session --issue-id issue-1
CYRUS_PORT=3600 apps/f1/f1 view-session --session-id session-1 --limit 30 --offset 0
CYRUS_PORT=3600 apps/f1/f1 view-session --session-id session-1 --limit 2 --offset 5
CYRUS_PORT=3600 apps/f1/f1 stop-session --session-id session-1
```

The session started at 12:47:46 UTC and posted its response at 12:48:08 UTC. The Read tool was denied by existing permissions, so the runner used the permitted shell read. The CLI still displayed `active` after completion; the successful runner result and response activity established completion before explicit cleanup.

## Guardrail regression verification

Real bare Git repositories reproduce the case seen in [Viora-Mono #847](https://github.com/VioraOS/Viora-Mono/pull/847#issuecomment-5760431566): the review checkout tracks `origin/main`, its PR commits are already published, and another writer advances the remote PR branch during review.

- Cached and uncached remote-history cases both failed before the fix and now allow completion.
- A diverged local commit still triggers the shipping guardrail.
- Local refs, tracking refs, `FETCH_HEAD`, and the working tree remain unchanged by verification.
- All 17 guardrail tests pass. The complete package suite passes with **2024 passed, 2 existing skips**; repository typecheck, lint and EdgeWorker build pass. Lint reports 10 existing warnings.

## Final retrospective

F1 covers the issue/session/activity pipeline; the bare-repository tests exercise the actual ancestry check and its effect on Git state. This run did not send any live GitHub comments or reactions.
