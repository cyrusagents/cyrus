# Test Drive: CYPACK-1521 ordered publication and final registry gate

**Date:** 2026-09-15
**Goal:** Verify that propagation waits do not interrupt dependency-ordered
uploads and that all registry artifacts pass before tagging/releasing.

## Baseline: completed v0.2.72 release (read-only measurement)

Source: [run 35032067991](https://github.com/cyrusagents/cyrus/actions/runs/35032067991),
job `104592610582`, SHA `5b3e38bdff77f560f2f3d5c47bc17d8d0fe55e08`.
GitHub reports success. No workflow was retried and no release was published
for this benchmark.

| Measurement | Evidence |
| --- | --- |
| Total run | 22:39:42–23:15:20 UTC = **35m38s** |
| Publish/verify step | 22:42:41–23:15:13 UTC = **32m32s** |
| Fresh uploads | **16** `+ package@0.2.72` completion markers |
| Recovery | **1**, `cyrus-zulip-event-transport`, skip logged 23:01:24.939620 UTC |
| Explicit propagation waits | **177** actual `Waiting for ...` lines, each followed by `sleep 10` = **29m30s scheduled sleep** |
| Logged publication intervals | **63.431496s aggregate**, from each `npm notice 📦` to its `+ package@version` marker |
| Remaining step time | About **118.57s**, including registry lookups, npm startup, recovery download/comparison, and shell overhead; not separately attributable from these logs |

The 63.43s is a lower bound on time inside `npm publish`: the workflow did not
log exact command start/end timestamps. It includes npm package inspection,
provenance, and upload work after the first package notice. It is not a network
transfer measurement. The 177 sleeps are counted from actual log messages,
excluding the echoed shell script. These confirm Connor's approximately
35-minute report without attributing all elapsed time to publication.

Logged intervals by fresh package (seconds):

| Package suffix (`cyrus-`) | Seconds |
| --- | ---: |
| cloudflare-tunnel-client | 3.737434 |
| mcp-tools | 3.959473 |
| core | 3.869230 |
| claude-runner | 4.200262 |
| config-updater | 3.994396 |
| linear-event-transport | 4.190451 |
| github-event-transport | 4.040403 |
| gitlab-event-transport | 3.986669 |
| slack-event-transport | 3.601990 |
| simple-agent-runner | 4.216243 |
| opencode-runner | 3.602803 |
| codex-runner | 3.894365 |
| cursor-runner | 4.074041 |
| gemini-runner | 4.051684 |
| edge-worker | 4.106249 |
| ai | 3.905803 |

Reproduce the raw evidence with read-only commands:

```sh
XDG_CACHE_HOME=/tmp/cypack-1521-cache gh run view 35032067991 \
  --json conclusion,headSha,createdAt,updatedAt,jobs
XDG_CACHE_HOME=/tmp/cypack-1521-cache gh run view 35032067991 \
  --log --job 104592610582 > /tmp/cypack-1521-release.log
```

## Executable workflow fixtures

`apps/cli/release-publish.test.ts` extracts and executes the actual main guard,
existing git-tag guard, publish/final-gate step, git tag/push, and GitHub release
shell. The fixture substitutes external npm/registry/git/GitHub commands and
accelerates only the polling clock. Every package comes from the production
ordered package list. The unrelated version/changelog validator is stubbed;
existing tests cover that validator separately.

- All 17 uploads occur in canonical dependency order at simulated time zero,
  before any registry polling sleep.
- Staggered visibility after 10/20/30 seconds needs **three shared sleeps**;
  every artifact is checked successfully in the 30-second pass before tagging.
  This is synthetic clock evidence, not a measured live release speedup.
- A partial release verifies recovered artifacts before uploads, skips them,
  then rechecks them at the final gate. Different gzip bytes with identical
  uncompressed tar content are accepted.
- Wrong content, wrong registry SHA-512, wrong tag, a missing package, or a
  recovered tag changing after uploads prevents both git tagging/pushing and
  GitHub release creation. Missing/wrong tags exhaust one shared 600-second
  deadline; content mismatches fail immediately.
- Existing content/tag mismatches and existing git tags stop before uploads.
  Non-main sources are rejected.
- Transient metadata/download failures recover; a persistent metadata outage
  authorizes no publication. Ambiguous failed writes are verified without
  issuing a second publish.
- Dry run verifies recovered artifacts and lists missing uploads, with zero
  publish/tag/push/release calls.

The new final gate has one 600-second budget for the graph rather than a
600-second budget per package. Preflight and recovery have separate shared
budgets; requests and uploads also have subprocess timeouts. Real wall time
still includes command startup, registry latency, downloads, packaging, and
other checks. No numerical live speedup is promised. The stronger gate also
verifies fresh tarball contents, which the old fresh-publish path did not.

## F1 pipeline smoke and full checks

The branch was rebased onto main `8056c529cc36` before validation.

- `pnpm build`: passed.
- `pnpm test:packages:run`: 1,878 passed, 2 skipped.
- `pnpm --filter cyrus-ai test:run`: 125 passed, including 16 executable
  release-gate scenarios and 8 static workflow checks.
- `pnpm typecheck`: passed.
- `pnpm lint`: passed with 12 pre-existing warnings; changed files are clean.
- `pnpm --filter cyrus-f1 test:run`: no test files; pipeline checked live below.
- Read-only `npm view cyrus-core@0.2.72 --json` confirmed the real registry's
  identity, tag, and dist metadata shape consumed by the script.

### F1 issue/session/activity protocol

**Test repository:** `/tmp/f1-cypack-1521/repo` (fresh scaffold)
**Port:** `3600`
**Issue/session:** `issue-1` / `DEF-1`, `session-1`

```sh
apps/f1/f1 init-test-repo --path /tmp/f1-cypack-1521/repo
CYRUS_PORT=3600 CYRUS_DEFAULT_RUNNER=codex \
  CYRUS_REPO_PATH=/tmp/f1-cypack-1521/repo bun run apps/f1/server.ts
CYRUS_PORT=3600 apps/f1/f1 ping
CYRUS_PORT=3600 apps/f1/f1 status
CYRUS_PORT=3600 apps/f1/f1 create-issue \
  --title 'CYPACK-1521 release workflow F1 smoke' \
  --description 'Inspect the configured F1 test repository and briefly report its implementation status. Do not edit files or publish anything.'
CYRUS_PORT=3600 apps/f1/f1 start-session --issue-id issue-1
CYRUS_PORT=3600 apps/f1/f1 prompt-session --session-id session-1 \
  --message 'Use the configured F1 Test Repository. This is a read-only smoke test; inspect its implementation and give a short final response.'
CYRUS_PORT=3600 apps/f1/f1 view-session --session-id session-1 --limit 10 --offset 0
CYRUS_PORT=3600 apps/f1/f1 view-session --session-id session-1 --limit 10 --offset 10
CYRUS_PORT=3600 apps/f1/f1 stop-session --session-id session-1
```

Codex used an isolated temporary state/auth directory. Server readiness, issue
creation, repository-selection recovery, worktree creation, runner startup,
mid-session prompting, timestamped activity rendering, two 10-item pagination
windows, final response delivery, and clean session stop were verified. The
server logged `Session completed (subtype: success)` at 23:28:53 UTC, and was
stopped through its process session after cleanup.

**Limitation:** as in the v0.2.72 release drive, the nested Codex sandbox failed
before local shell commands could start. The model was told to stop fallback
attempts and report the limitation; its final response correctly said repository
inspection could not run. This validates pipeline delivery and lifecycle, not
successful nested file inspection. `ping` also retains the known `Status:
undefined` display while the status endpoint reports `ready`. Release behavior
is validated by the executable fixtures above; no live npm write was attempted.

## Handoff

Reused CYPACK-1519's WIP (`e946c40bd162ad3493a830373e6844534244ba84`,
`handoff-cypack-1521-release-speedup`) as the starting point, replaced per-package
post-upload deadlines with the shared full-graph gate, and replaced its added
static-order assertion with executable fixtures. No duplicate release PR or
release dispatch was created. Independent review/merge remains with the
CYPACK-1521 follow-through owner.
