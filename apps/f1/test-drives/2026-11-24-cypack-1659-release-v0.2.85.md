# PR follow-through release v0.2.85

**Date** November 24, 2026  
**Runtime code tested** `0f63f55c7ecd5fca10d748fe9e5ea83eeed95a08` plus the release branch's version and changelog metadata  
**Previous release** `v0.2.84`

The only runtime change since v0.2.84 is #1619: PR follow-through now detects merge conflicts and base-branch staleness for pull requests tied to an existing session (`mergeConflictTrigger`, `prBranchFreshness`), and the generic base-branch push notice to running sessions is removed. Everything else is version and changelog metadata.

`node apps/f1/github-follow-through-drive.mjs` was run after `pnpm build` of the release branch. It drives the real EdgeWorker `/github-webhook` route with standard signed `pull_request` and `push` payloads and a fixture GitHub API and runner. It passed. The assertions show:

- Proxy mode needs Hosted admission: unauthorized and unadmitted deliveries send nothing, and the forwarded token is used. Direct signed delivery uses local config and credentials.
- With freshness off, no base-moved prompt reaches running sessions (the removed generic notice).
- With `merge` freshness, a behind PR is prompted and an up-to-date one is not.
- With `rebase`, a conflict sends exactly one conflict prompt using rebase.
- Duplicate deliveries and the per-PR cap hold.
- Cold opt-in, live config changes, atomic file replacement and removal take effect without restarting the worker.

Limitations: GitHub API and agent runner are fixtures; no live provider delivery or model execution.

## Router regressions versus what the F1 HTTP drive exercised

These were run on the release head (`0f63f55c` runtime code plus version/changelog metadata) with `vitest run test/GitHubFollowThroughRouter.test.ts` in `packages/edge-worker`: 38 of 38 passed.

**Router unit tests (`GitHubFollowThroughRouter.test.ts`), not exercised by the F1 HTTP drive:**
- `rotates the bounded base-push batch to reach later branches` passed. With 11 owned branches and a limit of 10 lookups per base push, the first push checks 10 branches and returns `{}`. The second push rotates the cursor, reaches the 11th branch and returns `{ 7: "accepted" }`, with 20 lookups in total.
- `checks later PRs when an earlier session cannot continue` passed. When one PR's session cannot continue (`Stopped session`), that PR gets `check_failed`, the error is reported once, and the next PR is still checked and accepted. This is the isolation of an earlier candidate's failure.

**F1 HTTP drive (`apps/f1/github-follow-through-drive.mjs`):** it passed. It covers Hosted admission, direct signature versus proxy delivery, freshness off/merge/rebase, one conflict prompt, duplicates, the per-PR cap, and cold, hot and atomic config changes through the real `/github-webhook` route with a fixture API and runner. It does not exercise ten-branch batch rotation or isolation of a failed earlier candidate. Those two behaviors are covered only by the router tests above.
