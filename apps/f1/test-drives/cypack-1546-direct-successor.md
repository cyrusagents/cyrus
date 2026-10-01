# Native direct child through production parent dispatch

## Database-clock production selection (2026-10-01)

Frozen Hosted `3da5b741861a67dc81922619939e7b33bf60991b`, installed Runtime
`d66ed0a86d0d925fe88469a142da93f640aee416`: **87tests/933assertions PASS24.92s**.
Hosted now selects eligible events before the bounded page and selects due outboxes
using database time. The existing fixture calls those actual SQL functions. Its
adapter now uses PostgreSQL `proretset` metadata to return SETOF rows as JSON arrays,
including empty sets and numeric revisions, matching PostgREST. Scalar RPC handling
is unchanged. The first run failed because that fixture adapter expected scalar
RPCs; its86/1 log remains at `attachments/successor-db-clock-3da5-d66/`.

The corrected run has **zero queue deferrals**, three logical/production drains
(including duplicate assertions), one successor reply, exact original constraints
and work identity, one fresh context read, zero memory/native/external writes.
No test-only second drain was used to get the first outbox delivered. Evidence and
source hashes: `attachments/successor-db-clock-3da5-d66-r2/inputs.json` and
`read-set-direct-child.json`. Use the reproduction below with Hosted3da5 and the
updated SQL adapter; executable bundle/image are unchanged.

This closes the exercised fresh-row clock-domain path. It does **not** prove a
deployed Workflow retries a deliberately future-dated row or caught transport
failure/backoff; that separate pending-delivery handoff remains open. Historical
8995 independent failures are retained and are not retroactively attributed.

## Original controlled proof

Frozen Hosted `8995bb5a2534b83b60ab00362e94f1cdd92dc9c8`, installed Runtime
`d66ed0a86d0d925fe88469a142da93f640aee416`. No new executable or test bundle:
this patch extends the existing native child launcher and its assertions.
F1 applies to this functional harness change.

**87 tests /933 assertions PASS,25.76s**. Three completed occurrences (original
parent, isolated child, fresh parent successor),9 actual native model requests,
3 native opens/closes,4 result transmissions including the original lost ACK.
[Bounded summary](evidence/cypack-1546-direct-successor.json).

The existing direct-child scenario remains intact. The extension gives its
original admitted operator input a real synthetic work thread and explicit
no-memory/no-work-change/no-external-write restrictions. The child returns a
synthetic finding plus a contrary save/post suggestion. The actual Hosted result
handler/SQL emits the internal event. The extension calls the production
`deliverCustomerAutomations`; it never constructs or inserts the successor outbox.
The registered route receives that persisted dispatch on the same installed
runtime/ledger. Three dispatcher calls (including a duplicate before completion)
produce one successor outbox and one linked reply.

The successor negotiates native context through the actual callback/SQL, performs
one fresh read_context, and starts a new contained native turn. Assertions check
originalInput byte-for-byte, original parent session and revision, work identity,
child findings, the entire assembled prompt, and the entire prompt again on the
actual native provider request. The deterministic model emits only the summary.
Final SQL assertions verify the original work-thread reply, zero facts, zero
native writes and zero Slack reply effects. Original isolation, scoped reads,
ordered activities, lost-ACK and SQL stale/foreign/revision checks remain.

Boundaries: the initial/child outbox delivery, model/provider transport, registered
transport/credential resolution and scheduler wake trigger remain controlled.
Production successor dispatch, admission, SQL, HTTP, SDK, native container and
receipt paths are actual. This proves instruction delivery, not live-model
obedience, signed ingress or responsiveness. No live runtime/home/customer state
was read or changed. Ticket-backed lifecycle retains separate native/SQL coverage;
this new production successor extension selects the direct case only.

## Reproduction

Use the unchanged17-package d66 bundle and approved image from
`attachments/async-child-d66ed0a8/HANDOFF.md`, then:

```sh
CYRUS_TEST_DOCKER_PATH=/usr/local/bin/docker \
CYRUS_TEST_DOCKER_HOST=unix:///var/run/docker.sock \
CYRUS_F1_CODEX_IMAGE=sha256:35ffa8e695666695f047cf527138b9b27f2e1c29d44673f9eb705a0e4010be4f \
CYRUS_NATIVE_JOIN_PARENT_SUCCESSOR=1 \
CYRUS_NATIVE_JOIN_MODES=read-set-direct-child \
node apps/f1/native-context-join/run-hosted-native.mjs HOSTED_CHECKOUT \
  8995bb5a2534b83b60ab00362e94f1cdd92dc9c8 INSTALLED_PREFIX \
  d66ed0a86d0d925fe88469a142da93f640aee416 NEW_EVIDENCE_DIRECTORY
```

The launcher freezes Hosted source, preserves original/adapted files and hashes
all helper sources. Local evidence: CYPACK attachments/direct-successor-8995-d66-r3.
Two earlier attempts are preserved: a new observer mistakenly treated an authority
getter as an object, so its expected context was undefined. The saved synthetic
native transcript already contained the full correct prompt. Correcting the
fixture getter produced this pass; no Runtime/Hosted authority fix was made.

## Protocol review

This join explicitly enables server-owned `current-sql-v1`; full scoped catalog
and tool checks remain. Frozen Hosted protocol suite independently passes7/68.
[The contract review](../../../docs/mcp-protocol-admission.md#exact8995-review)
records remaining GET/notification/fallback negative-branch gaps handed to Hosted.
No live performance claim follows from these controlled timings.


## Independent replay diagnostic follow-up

The coordinator's frozen 6315/d66/8995 replay failed with 86 passes and one failure:
its child-result outbox was not marked delivered. The old assertion did not expose
whether production dispatch rejected a request or skipped a not-yet-due row.
The fixture now retains up to 64 fixed transport/ACK and SQL error-code records,
and reports attempt count, relative next-attempt time, database clock offset and
whether the binding recorded an error. It does not record credentials, request
bodies or provider content. Dispatch semantics and all existing assertions are unchanged.

Author replay of the diagnostic driver with the same installed d66 and frozen
Hosted 8995 passed 87 tests / 933 assertions (25.80s). Evidence is in
`/Users/agentops/.cyrus/CYPACK-1546/attachments/successor-diagnostics-8995`.
This does **not** explain or supersede the independent failure; that environment
needs the diagnostic replay before a cause or correction can be claimed.


The second independent replay exposed attempts=0 and no binding/transport/SQL
error. A targeted PostgreSQL/actual-adapter experiment proves a submillisecond
queue boundary can produce exactly that outcome: row timestamp `.123456` is
excluded by the dispatcher's JS cutoff `.123`, then included at `.124`, without
changing attempts or authority. This is a candidate explanation, not attribution
of the independent run. Diagnostics now record selected row count and compute
`next_attempt_at - actual queue cutoff` in PostgreSQL at full precision. Date
conversion in the old diagnostic discarded milliseconds; it is corrected.
No extra dispatch retries or relaxed due predicate have been added.


## Bounded due-time fixture correction

The fixture now invokes a subsequent **production drain** only when SQL proves
`0 < next_attempt_at - first_queue_cutoff <= 100ms`, the successor has zero
attempts, no binding error and no recorded SQL/HTTP failure. It waits at most
102ms; it does not change rows, due filtering, attempts, input, credentials or
authority. Any other undelivered row still fails with the exact bounded diagnostic.
A second unsuccessful drain also fails. Three logical probe requests can now
produce four production drains; evidence reports both counts and the exact gap.

Controlled installed d66/frozen Hosted8995 validation:

- `CYRUS_NATIVE_JOIN_QUEUE_DELAY=1` changes only the fresh fixture DB's new-outbox
  default to now()+50ms for the first drain, then restores it. PASS87/933 in27.07s.
  SQL measured49.922ms after cutoff; one subsequent drain, one actual successor
  delivery, one reply, three native opens/closes, nine requests, zero memory or
  external writes. Exact original restrictions/work identity assertions remain.
- `CYRUS_NATIVE_JOIN_DISPATCH_REJECTION=1` returns a controlled403 only for the
  successor occurrence transport. Expected suite failure86/1 remains fatal with
  attempts1, binding error true, one403, **zero** due-time re-drains. The external
  negative-probe assertions pass. This tests error preservation, not live auth.

Evidence: `attachments/successor-queue-delay-8995-r3/queue-boundary-summary.json`
and `attachments/successor-denial-8995-r3/` under the issue's attachments root.
Original failed independent runs and earlier diagnostic source remain preserved.
No attribution of the independent failure is claimed until its full-precision
queue-cutoff evidence is available. No production Runtime or Hosted code changed.
The existing normal replay command needs no flag; the two flags above are only
for deterministic positive/negative fixture probes.

## Actual Workflow retry after occurrence ACK loss

Installed Runtime03ce05d2 and frozen Hosted
`0cc0180279543a3262a51472535999bf6b9c3794`: **87tests/933assertions PASS55.87s**.
With `CYRUS_NATIVE_JOIN_WORKFLOW_RETRY=1`, the original successor fixture invokes
actual `customerAgentDispatchWorkflow` rather than calling the dispatcher directly.
Only unrelated source reconciliation/engineering/reply work is stubbed. The
registered transport accepts the exact successor occurrence then loses its ACK.
Actual SQL retains attempts1 and an undelivered receipt. Hosted's real Workflow
throws the SDK `RetryableError` because pending delivery includes future backoff.

The controlled Workflow runner waits the actual29,998ms `retryAfter` deadline,
then invokes that same Workflow again. SQL proves unchanged row/input/occurrence,
attempts2 and delivered state. Exactly one successor model turn/reply, no memory or
external writes, original constraints/work identity and ordered final ACKs remain.
There are three logical probes and four production drains (one actual Workflow
retry), zero fixture queue-deferral drains. No direct ledger/outbox edits, artificial
clock advance or operator retry. Real installed native/SQL/HTTP/MCP; Workflow
platform persistence, model/provider and registered-target transports controlled.

The same injected loss against frozen8ddc fails as expected86PASS/1FAIL/884assertions:
Workflow returns with an undelivered row instead of requesting a retry. This red
case is preserved at `attachments/workflow-retry-8ddc-before/`; the passing case,
exact helpers/hashes and summary are at `attachments/workflow-retry-0cc0-03ce/`.
Enable the new flag with the existing reproduction command and those exact SHAs.
The normal fixture retains its original assertions; this mode refuses the legacy
queue-delay or permanent-rejection probes and cannot fall back to manual re-drain.

This proves production Workflow code requests and carries out the bounded retry
when driven according to its real SDK deadline. It does not claim an actual cloud
Workflow infrastructure outage/restart test or live speed acceptance.
