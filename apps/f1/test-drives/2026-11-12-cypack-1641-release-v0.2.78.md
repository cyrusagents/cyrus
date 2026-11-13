# Release v0.2.78: runtime verification

**Date:** 2026-11-12
**Issue:** [CYPACK-1641](https://linear.app/ceedar/issue/CYPACK-1641)
**Tested source:** `4ba661a9` plus the release-prep changes (version bumps, changelog moves, `@modelcontextprotocol/sdk` ^1.32.2 and lockfile refresh of hono / @hono/node-server).
**Previous release:** `v0.2.77`
**Result:** PASS for the checks below. npm publication is a separate gate.

## Full-payload assessment

One PR has merged since v0.2.77 (`git log v0.2.77..origin/main`): **#1590**, which routes GitHub CI failures (commit statuses and check runs) to the responsible existing session. It changes EdgeWorker routing and session delivery, so F1 is applicable. The release prep adds a dependency security refresh (hono advisories) with no source changes.

## F1 drive

`pnpm build`, then `node apps/f1/github-ci-routing-drive.mjs`. It exercises the real HTTP endpoint, EdgeWorker transport registration, session delivery and the live config watcher. GitHub API and runner are deterministic fixtures.

Output: `PASS: actual HTTP -> EdgeWorker -> responsible session stream; unauthorized/stale/duplicate deliveries do not dispatch. Live file edits, atomic replacement and removing opt-in work without restarting the worker. Runner/API are fixtures.`

Limitation: no live model execution or live GitHub delivery; this is routing/session-delivery evidence.

## Other checks

- `pnpm build`, `pnpm typecheck`: passed.
- `pnpm test:packages:run`: all passed (edge-worker 947 passed / 1 skipped, github-event-transport 127, core 206, config-updater 79, claude-runner 150, others unchanged).
- `pnpm --filter cyrus-ai test:run`: 162 passed.
- `pnpm lint`: passed, 14 existing warnings.
- `pnpm audit --audit-level low`: initially 7 hono/@hono/node-server advisories via config-updater > @modelcontextprotocol/sdk; fixed by bumping the SDK to ^1.32.2 in its three owning packages and refreshing the lockfile; now zero advisories, no override added.
