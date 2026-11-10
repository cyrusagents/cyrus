# GitHub CI failures (CYPACK-1635)

Companion PRs: [runtime #1590](https://github.com/cyrusagents/cyrus/pull/1590) and
[Hosted #1347](https://github.com/cyrusagents/cyrus-hosted/pull/1347).

This change routes CI failures into one existing Cyrus session. It does not create
an issue, select a default repository/session, or act on app-authored review comments.
Historical customer request: [CYR-5](https://linear.app/ceedar/issue/CYR-5/cicd-feedback-cyrus-feature-suggestion).

## Provider events and current paths

[Semaphore documents](https://docs.semaphore.io/using-semaphore/tasks) that each
pipeline reports a **commit status** to GitHub. Its
[GitHub integration guide](https://docs.semaphore.io/using-semaphore/connect-github)
shows contexts such as `ci/semaphoreci/push: <pipeline>`.
[GitHub's webhook reference](https://docs.github.com/en/webhooks/webhook-events-and-payloads#status)
defines failure/error/pending/success statuses. Handle `status` **failure** and
**error**, and `check_run` **completed** with failure, timed_out, action_required,
or startup_failure. Success, neutral, skipped, cancelled, and incomplete checks do
not trigger. `check_suite` and `workflow_run` are intentionally not additional
triggers: individual check runs provide the identity and avoid duplicate suite/run
notifications. This includes GitHub Actions check runs. A provider rerun is checked
against the current GitHub API state before dispatch.

Before this change Hosted's `/api/github/webhook` verified HMAC, independently
published configured event-channel notifications, and handled PR bookkeeping,
comments/reviews and pushes. It had no CI forwarding. Runtime `/github-webhook`
accepted comments/reviews/pushes only; comment events create fresh GitHub sessions.

Now Hosted preserves raw signed bytes and delivery/event headers, looks up the
installation junction and **one** active repository with matching numeric ID,
installation ID and canonical URL, refreshes stale configuration, mints an
installation token, then forwards. Ambiguous teams never use the legacy
`resolveTeamIdForInstallation` earliest-team fallback. Cloud uses the droplet's
Bearer key; Hosted-connected self-host uses the tunnel's Bearer key. Direct
self-hosted delivery keeps HMAC and IP admission. Existing comment forwarding
and event-channel subscription behavior remain unchanged. CI is not added as a
new event-channel subscription in this change.

## Runtime association

1. Require one configured active repository with the event URL; verify its numeric
   ID via the authenticated GitHub API. Use existing org token-store / forwarded
   installation / self-minted installation / PAT resolution. Never fetch provider
   URLs or expose authentication headers.
2. Enumerate open PRs (bounded, at most 1,000); require exactly one whose current
   head SHA or merge SHA matches. Refresh its detail, reject forks/closed PRs and
   wrong base/head repository IDs. For merge SHAs, verify the commit includes the
   current PR head as a parent. Never infer a PR from `branches`, webhook PR hints,
   PR text, a Cyrus marker, or a default branch.
3. Verify the newest status for the context, or latest check run for the app/name,
   still has this event's ID and a failure state. API errors/pagination exhaustion
   fail closed. Recheck PR and failure immediately before dispatch.
4. Require exactly one known session whose repository ID and branch match. Multiple
   sessions on the same branch are ambiguous: no "most recent" guess. No association
   means an explicit `session_not_found` outcome and no new session. Another
   delivery is needed if a session is subsequently restored or becomes available.
5. Continue the active streaming runner, or resume the existing issue/GitHub session
   with its existing runner ID. A busy non-streaming runner is not interrupted.
   Missing workspace/runner state, errored/stopped sessions and unsupported chat
   origins fail delivery rather than creating replacement work. Idle GitHub sessions
   continue with GitHub tool/MCP configuration; idle issue sessions use their normal
   continuation path. Resumed turns have a 50-turn limit.

The prompt includes repository, PR, current head SHA, tested SHA, event type,
check/status ID, context/name, failure state and a canonical GitHub PR checks URL.
It directs the agent to recheck the revision before editing, examine all failing
checks on that revision, and treat CI metadata as untrusted data. It excludes raw
output/descriptions and provider URLs, which can contain credentials. Private
Semaphore logs require separately authorized access; GitHub permissions do not
make those logs public. No Semaphore token or log scraping is added.

## Deduplication, retries and visibility

`~/.cyrus/ci-dispatch/<sha256(repository-id:pr-number)>/<head-sha>.json` stores a
credential-free journal. A filesystem directory lock serializes reservations
across processes; an in-process session reservation also prevents overlapping
CI starts for a multi-repository session. At most **one automatic prompt per PR
head** and **three heads per PR** are allowed, including status/check overlap,
new status IDs, reruns, delivery-ID changes and process restarts. The prompt asks
for all failures on that head, since subsequent failures do not cause another turn.
Budgets do not reset after success, new sessions or process restart. A later human
prompt remains possible through existing channels.

Runtime acknowledgement `ciProtocol: 1, outcome: accepted` means the session was
reserved and dispatch scheduled, **not that the agent completed or fixed CI**.
The journal starts `dispatching`, becomes `completed` after the runner call
returns (for streaming this means stream acceptance), or `failed` on rejection.
Failures are logged with the session ID. Live duplicates receive `duplicate_revision`;
after a crash an unfinished `dispatching` entry returns 503 for reconciliation.
Exactly-once execution cannot be transacted atomically with an agent runner; this
implementation favors avoiding duplicate edits over automatic crash replay.

Lookup, API/auth, unavailable runtime, busy session, preparation and lock-contention
failures return 503 and have not consumed a dispatch reservation. Hosted sends a
credential-free Sentry event for forwarding failure and returns 503 to GitHub.
It also rejects old runtimes' 200/ignored response unless they acknowledge the CI
protocol. Unmatched/ambiguous events and attempt-limit outcomes are explicit 200
responses, with no agent execution. The original GitHub check remains failed.

**GitHub does not automatically redeliver failed webhooks.** After restoring
configuration, permissions, availability or idle session state, use the App's
Recent deliveries → Redeliver, or an authorized delivery-retry API workflow.
Successful redelivery before dispatch can proceed; delivered revisions deduplicate.
There is no Hosted outbox, scheduled retry worker, or customer notification added.
See [GitHub's failed-delivery guide](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries).

For stale filesystem locks or failed/unfinished dispatch entries: stop the affected
runtime, inspect its session transcript and journal, and establish whether the
prompt was accepted or work ran. Preserve the journal as evidence. Only an operator
who confirms **no agent work was accepted** should remove that reservation/lock
and redeliver. Otherwise keep the reservation and prompt the existing session
manually. Do not indiscriminately clear journals or reset the three-head budget.
Journal retention is indefinite for this version; deleting it removes deduplication.

## Configuration and rollout (not performed by this PR)

- Deploy/release the companion runtime **before** enabling Hosted forwarding for
  existing installations; old runtimes produce visible 503 responses.
- GitHub App repository permissions: **Commit statuses: Read**, **Checks: Read**,
  **Pull requests: Read** (existing write suffices), and existing metadata access.
  The self-host setup manifest now requests `statuses: read`, `checks: read` and
  subscribes to `status`, `check_run`.
- Existing Hosted and self-host Apps must manually enable the **Status** and
  **Check run** event subscriptions and accept any new installation permission
  request. No live App settings or customer configuration were changed. Hosted
  has no checked-in App manifest to backfill; the owner must change the App settings.
- Keep the existing webhook secret, installation selection, repository activation,
  tunnel/droplet credentials and private CI access in place.

## Evidence boundaries

Focused tests cover authenticated admission, stale/success/malformed events,
repository/installation/team isolation, PR/session ambiguity, current merge SHA,
latest-state verification, retries, concurrency, restart deduplication and loop caps.
`EdgeWorker.ci-continuation.test.ts` checks streaming and idle issue/GitHub resumes.
`apps/f1/github-ci-routing-drive.mjs` exercises actual local HTTP → EdgeWorker →
AgentSessionManager → the intended session's stream, with API/runner fixtures.

The companion Hosted tests use the real signed outer route for signature admission;
its cross-checkout test uses the real Hosted forwarder plus runtime Fastify transport
and router. Database, GitHub API and runner boundaries are fixtures. To reproduce:

```sh
# Cyrus
pnpm build
pnpm --filter cyrus-edge-worker test:run test/GitHubCiRouter.test.ts test/EdgeWorker.ci-continuation.test.ts
bun apps/f1/github-ci-routing-drive.mjs
# Hosted apps/app (sibling Cyrus checkout already built)
CYPACK_CYRUS_CHECKOUT=/absolute/path/to/cyrus bun test --isolate src/lib/github/forward-ci-failure.test.mjs src/lib/github/ci-webhook-auth.test.mjs
```

No live Semaphore webhook, customer GitHub delivery, real model execution, CI fix,
production deployment or customer communication is claimed. A separately authorized
staging/customer exercise should confirm actual delivery payloads, subscriptions,
private-log access and the resulting agent transcript before rollout.
