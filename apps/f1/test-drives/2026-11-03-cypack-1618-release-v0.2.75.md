# Release v0.2.75: runtime verification

**Date:** 2026-11-03
**Issue:** [CYPACK-1618](https://linear.app/ceedar/issue/CYPACK-1618)
**Tested commit:** `acdb4ff3b43474751fad9a15cf067594b84137d6` (`chore: release v0.2.75 (CYPACK-1618)`), branch `cypack-1618`
**Previous published release:** `v0.2.73` (v0.2.74 was prepared but never published; its payload ships for the first time inside v0.2.75)
**Test repositories:** `/tmp/f1-test-drive-cypack-1618-<ts>/repo-primary`, `/tmp/f1-test-drive-cypack-1618-<ts>/repo-secondary` (both removed after the drive)

## Full-payload applicability

The released payload is `git log --first-parent v0.2.73..HEAD`, 20 commits. This
includes the entire unpublished v0.2.74 payload (Codex sandbox writable paths,
Codex CLI/SDK 0.159.2 and `gpt-6.1-sol`, authorized inbox publication,
self-host listener-port persistence, operator-selectable Codex sandbox modes,
and dependency patches) plus six commits merged after the v0.2.74 evidence was
captured (since `de7d29e2`):

- `#1546` — repository-selection replies that Linear rewrites into markdown links now match the chosen repository (`EdgeWorker`/`RepositoryRouter`)
- `#1532` — label routing scoped to a repository's `teamKeys`
- `#1562` — `linear_agent_give_feedback` delivered to child sessions restored after a restart
- `#1566` — Cloudflare tunnel restart after an unexpected child exit
- `#1573` — GitHub webhook IP allowlist ranges
- `#1487` — managed GitHub credentials fail closed on removed/expired/unreadable installation auth
- `#1555` / `#1563` / `#1569` — Fastify, Zod/body-parser/fast-uri + Cursor SDK runtime, and Axios/`follow-redirects` security bumps
- `#1558` — moved the Cyrus Inbox plugin package to a private repository (packaging only, no runtime behavior change)

All of the above except `#1558` are runtime/product changes exercised by F1,
so F1 coverage is required for this release per the applicability policy. The
v0.2.74 report (`2026-10-20-cypack-1592-release-v0.2.74.md`) already carries
live-F1 and isolated-OS-sandbox evidence for its payload (Codex sandbox
writable paths, Codex 0.159.2/`gpt-6.1-sol`, inbox publication transport,
sandbox-mode feature report) — **that evidence is carried forward here, not
re-run**, since none of the files it exercised changed again between
`de7d29e2` and `HEAD`. This report adds the evidence for the six
post-v0.2.74 commits above.

## Live F1 scenario 1: standard issue session end-to-end

Validates the server/runtime path shared by every session (Fastify HTTP
server, Zod-validated config/MCP schemas, the updated MCP SDK, Axios/
`follow-redirects`) actually executes a real session on this build.

Server:
```sh
cd apps/f1
./f1 init-test-repo --path /tmp/f1-test-drive-cypack-1618-<ts>/repo-primary
./f1 init-test-repo --path /tmp/f1-test-drive-cypack-1618-<ts>/repo-secondary
CYRUS_PORT=3601 \
CYRUS_REPO_PATH=/tmp/f1-test-drive-cypack-1618-<ts>/repo-primary \
CYRUS_REPO_PATH_2=/tmp/f1-test-drive-cypack-1618-<ts>/repo-secondary \
bun run apps/f1/server.ts &
```
Each repo got a distinct `ROUTING_ID.txt` marker (`PRIMARY_OK_F1` /
`SECONDARY_OK_F1`) committed on `main`.

Commands:
```sh
CYRUS_PORT=3601 ./f1 ping
CYRUS_PORT=3601 ./f1 status
CYRUS_PORT=3601 ./f1 create-issue -t "Read routing marker (standard session)" \
  -d "[repo=f1-test-repo] Read the file ROUTING_ID.txt in the repository root and reply with exactly its contents, with no other text. Do not edit any files."
CYRUS_PORT=3601 ./f1 start-session --issue-id issue-1
CYRUS_PORT=3601 ./f1 view-session --session-id session-1
CYRUS_PORT=3601 ./f1 view-session --session-id session-1 --limit 2 --offset 0
CYRUS_PORT=3601 ./f1 view-session --session-id session-1 --limit 2 --offset 2
CYRUS_PORT=3601 ./f1 stop-session --session-id session-1
```

Passed assertions:
- Server health (`ping`, `status`) and issue creation (`issue-1` / `DEF-1`) succeeded.
- `[repo=f1-test-repo]` description-tag routing selected exactly `F1 Test Repository` (log: `Repositories selected: [F1 Test Repository] (description-tag routing)`); a real git worktree was created for `DEF-1`.
- Five timestamped activities appeared in order: two routing/intro thoughts, a model-selection thought (`claude/claude-sonnet-5`), a `Read` tool action, and a final `response` activity whose body was exactly `PRIMARY_OK_F1` — the real contents of the primary repo's marker file, read through the actual `Read` tool.
- Pagination returned the first two activities at `--limit 2 --offset 0` and the next two at `--offset 2`, both tagged "Showing 2 of 5 activities".
- `stop-session` returned success.

## Live F1 scenario 2: repository-selection reply as a Linear markdown link (#1546)

F1's stock multi-repo mode (`CYRUS_REPO_PATH_2`) configures two repositories
under the same `linearWorkspaceId`, each with its own `teamKeys`/
`routingLabels`/`githubUrl` — exactly the shape `RepositoryRouter` needs to
exercise `needs_selection` and the markdown-link reply-matching fix.

Commands (same running server):
```sh
CYRUS_PORT=3601 ./f1 create-issue -t "Ambiguous routing repo selection test" \
  -d "Read ROUTING_ID.txt in the repository root and reply with exactly its contents, no other text. Do not edit any files."
CYRUS_PORT=3601 ./f1 start-session --issue-id issue-2
CYRUS_PORT=3601 ./f1 view-session --session-id session-2
CYRUS_PORT=3601 ./f1 prompt-session --session-id session-2 \
  --message "[https://github.com/f1-test/secondary-repo](<https://github.com/f1-test/secondary-repo>)"
CYRUS_PORT=3601 ./f1 view-session --session-id session-2
CYRUS_PORT=3601 ./f1 stop-session --session-id session-2
```

Passed assertions:
- With no description tag, label, team-key, or project match for either
  configured repository, the router logged `No routing match for 2 workspace
  repositories - requesting user selection` and posted a real `elicitation`
  activity (`Which repository should I work in for this issue?`) with two
  options keyed by each repo's `githubUrl`.
- Replying with the Linear-autolinked markdown-link form of the **secondary**
  repository's GitHub URL — `[https://github.com/f1-test/secondary-repo](<https://github.com/f1-test/secondary-repo>)`
  — produced `Routing (User selection) - F1 Secondary Repository`, not the
  first/primary repository (which is what the pre-#1546 bug would have
  selected as a fallback).
- The resulting session ran in the secondary repo's real worktree
  (`/tmp/cyrus-f1-.../worktrees/secondary/DEF-2`) with that repo's actual
  filesystem permissions (`Read(//.../repo-secondary/**)`), confirming the
  match drove real routing, not just a log line.
- The final `response` activity body was exactly `SECONDARY_OK_F1` — the
  secondary repo's own marker file, confirming the correct repository was
  used end-to-end, not the primary one.
- `stop-session` returned success for `session-2`.

## `#1532` teamKeys label routing

F1's stock multi-repo config already assigns each repository distinct
`teamKeys` (`PRIMARY` / `SECONDARY`) and `routingLabels`, the same shape used
to reproduce and fix the cross-team label collision in #1393/#1532. Rather
than re-running a duplicate live drive, the existing committed feature report
([`2026-10-26-teamkeys-label-routing.md`](2026-10-26-teamkeys-label-routing.md))
already performed a live F1 drive at this fix (two repositories sharing a
`Design` routing label scoped to different `teamKeys`, a `DEF-1` issue
selecting only the correctly-scoped repository, negative control against the
pre-fix router reproducing the cross-team bug) plus 86 `RepositoryRouter`
unit tests and a full 860-test `cyrus-edge-worker` run. That evidence is
carried forward unchanged, since the file has not changed again since that
drive.

As current-HEAD confirmation (not a new live drive), the focused suite was
re-run on this exact commit:
```sh
pnpm --filter cyrus-edge-worker exec vitest run test/RepositoryRouter.test.ts --maxWorkers=2
```
Result: **86 passed** (unchanged from the referenced report).

## Focused existing suites for #1562, #1566, #1487, #1573

```sh
pnpm --filter cyrus-edge-worker exec vitest run test/EdgeWorker.feedback-delivery.test.ts --maxWorkers=2
pnpm --filter cyrus-cloudflare-tunnel-client exec vitest run test/CloudflareTunnelClient.recovery.test.ts --maxWorkers=2
pnpm --filter cyrus-config-updater exec vitest run test/managed-github-auth.test.ts test/gh-cyrus.test.ts test/git-credential-cyrus.test.ts --maxWorkers=2
pnpm --filter cyrus-core exec vitest run test/security/WebhookIpValidator.test.ts --maxWorkers=2
```

Results, all green on `acdb4ff3`:

| PR | Suite | Result |
| --- | --- | --- |
| #1562 | `EdgeWorker.feedback-delivery.test.ts` | 11 passed |
| #1566 | `CloudflareTunnelClient.recovery.test.ts` | 19 passed |
| #1487 | `managed-github-auth.test.ts`, `gh-cyrus.test.ts`, `git-credential-cyrus.test.ts` | 37 passed (3 files) |
| #1573 | `security/WebhookIpValidator.test.ts` | 75 passed |

No scenario in this section was blocked by the sandbox environment; all four
suites ran directly with `vitest run` and no external network, credentials,
or OS-level sandbox dependency.

## Dependency security bumps (#1555, #1563, #1569)

- `#1555` (Fastify 5.12.7) and `#1569` (Axios 1.21.0 / `follow-redirects`
  1.16.2) are exercised indirectly by every HTTP-serving path in scenarios 1
  and 2 above (the F1 server itself runs on the same Fastify-backed
  `SharedApplicationServer`, and the real session/routing/activity traffic
  flows through it).
- `#1563` (Zod/body-parser/fast-uri patch plus the accompanying Cursor SDK
  1.1.0 runtime bump) already has dedicated live-F1 evidence in
  [`2026-10-27-cypack-1603-cursor-sdk-runtime.md`](2026-10-27-cypack-1603-cursor-sdk-runtime.md):
  a real Cursor create+resume session, persisted SQLite agent store, activity
  rendering, hook cleanup, and graceful stop. That evidence is carried
  forward unchanged.
- `pnpm audit` on `acdb4ff3`: **no known vulnerabilities found** — confirms
  the three security bumps keep the dependency graph at zero advisories on
  the released commit.

## `#1558` (packaging only)

Moving the Cyrus Inbox plugin package to a private repository has no F1
relevant runtime behavior change (the CLI, runtime and `post_message_to_codex`
tool are explicitly unchanged per the changelog entry); it is a packaging
move, not a workflow change, so it is not covered by a live F1 scenario here.

## Cleanup

Both F1 processes (`session-1` stopped, `session-2` stopped) were stopped via
`stop-session`, the background `bun run apps/f1/server.ts` process on port
3601 was killed, and all temporary directories created for this drive
(`/tmp/f1-test-drive-cypack-1618-<ts>/`, the matching `/tmp/cyrus-f1-<ts>/`
CYRUS_HOME, and the env/log scratch files) were removed. No files other than
this report were created or modified in the repository.

## Result

**Pass.** Scenario 1 (standard issue session end-to-end) and scenario 2
(markdown-link repository-selection reply, #1546) both ran live against this
build with real routing, worktrees, activities, and final responses, and both
passed their assertions. `#1532` teamKeys label routing is covered by the
carried-forward live feature report plus a current-HEAD rerun of its 86 unit
tests (passed). The four focused suites for #1562, #1566, #1487, and #1573
all passed (11 / 19 / 37 / 75 tests respectively). The three dependency
security bumps are covered by the live HTTP-serving traffic in scenarios 1–2,
the carried-forward Cursor SDK runtime drive for #1563, and a zero-advisory
`pnpm audit` on the released commit. `#1558` is packaging-only and needs no
F1 coverage. No live scenario was blocked in this environment.
