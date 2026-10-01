# Automation latency diagnostics

These diagnostics measure supervisor stages. They are independent of the durable
session execution counter and do not change its exclusions or user-facing meaning.
They do not authorize work, refresh a lease, replay a command or change receipts.

## Existing live evidence, not a new model test

The verifier's saved `2026-09-30-0576602a-staging-greeting.json` identifies installed
runtime8a3 and a mixed Hosted0576602a→60ae3f49 deployment window. Source-free turns:

| Occurrence prefix | Scheduled to native start | Native start to complete | Tools |
| --- | ---: | ---: | ---: |
| 2047d927 | 11.377s | 6.086s | 0 |
| 3130d9c3 | 44.752s | 25.679s | 0 |
| 3766f522 | 44.024s | 11.380s | 0 |

For3130, verifier send to scheduled is3.957s. These are differences between recorded
wall-clock timestamps, not stage spans or proof of synchronized browser/host clocks.
Runtime `scheduledAt` for an instruction is produced during ledger enqueue; it does
not identify when Hosted sent/received its HTTP request or when a runtime claim won.
The safe record lacks claim/admission, session ACK, container initialization, first
model request and provider-response timestamps. The44s cannot be apportioned from
these records. Zero tools excludes a completed tool workflow, not supervisor waits.
The earlier8a3 read's51.830s pre-native gap has the same missing boundaries.

The separately recorded500ms-RTT fixture improvement on16779 validates a removed
roundtrip. It is not a measurement of live RTT or a resolution of historical44s.
A saved-message ACK and a later UI Waiting label are Hosted presentation/dispatch
boundaries; no runtime timing record proves how long a page rendered a blank state.
Hosted owns the already-reproduced UI continuity correction.

## Opt-in collection and retrieval

A runtime operator can set `CYRUS_AUTOMATION_LATENCY_DIAGNOSTICS=1` at a future
coordinated launch. It defaults off; no model/request parameter enables it. This is
not permission to restart an existing runtime. Pairing, preview origin, native
image and same-user credential brokerage are unchanged. No new endpoint, listener,
negotiation header, journal schema or checkpoint/ledger migration is introduced.

The existing supervisor-authenticated
`GET /api/automations/v1/status/:automationId` adds optional `latencyDiagnostics` to
an occurrence already in that response ONLY when the authenticated request includes
`X-Cyrus-Latency-Diagnostics: 1`. Ordinary status responses remain unchanged even
when collection is enabled, preserving Hosted's bounded status reader. This header
only selects collected metadata; it cannot enable collection or grant authority.
Do not export the entire status response:
it contains existing private occurrence input. Export only the diagnostic subobject
using existing secure supervisor transport; never print authentication headers.
Nothing is logged automatically. No diagnostic fields enter model/MCP context.

The object has `version:1`, `retention:"process-memory"`, numeric `attempt` (or null
before claim), `elapsedMs`, `finished`, `droppedSpans`, and at most128 `spans`.
Each span contains only an enumerated `stage`, `startMs`, optional `durationMs`, and
optional `failed:true`. No customer/provider/native IDs, prompts, tools/arguments,
raw errors, tokens, absolute timestamps or paths are recorded. Existing occurrence
identity in the authenticated response provides correlation without another ID.

At most64 occurrence traces are retained per runtime. Repeated dispatch does not
reset a retained trace. A new claim replaces that occurrence's previous attempt.
Restart or eviction loses diagnostics; absence is not zero. Scheduled/offline/retry
claims without a newly observed dispatch start at claim, and do not fabricate queue
time from historical wall clocks. Trace collection never writes durable state.
Unfinished spans have no duration; a truncated list has positive `droppedSpans`.
These are incomplete measurements, not successful zero-duration operations.

## Stage semantics

- `dispatch.received`: authenticated occurrence handler entry after HTTP parsing;
  no measurement of browser, tunnel, socket arrival or pre-handler body parsing.
- `dispatch.enqueue`: synchronous enqueue including SQLite lock/transaction wait.
- `queue.wait`: observed enqueue end to start of successful claim. Includes local
  scheduling/concurrency wait; absent when original dispatch was not observed.
- `ledger.claim`: actual synchronous claim transaction, including lock wait. It can
  be shared by several claims, so do not sum it across concurrent occurrences.
- `authorize.admit` / `authorize.renew`, `progress`, `result`, `interrupt`: gateway
  call through response parse. No decomposition of network versus Hosted SQL.
- `checkpoint.load`: local checkpoint read. `session.create`: initial journal
  creation/ACK boundary. `session.delivery`: each actual delivery through validated
  ACK, including immutable retries; `session.finalFlush`: ordered final ACK barrier.
- `container.initialize`: isolated process launch, image checks and app-server
  initialization. `native.thread`: thread start or resume request;
  `native.turnStart`: turn/start request. The existing native protocol's
  `native.started`, `native.activity` and `native.completed` are marker spans.
  Native activity is an item lifecycle event, not proof of a visible user token.
- `model.request`: native model callback arrival, before its current-authority and
  snapshot gates. `credential.read` / `credential.refresh`: broker-only waits.
  `provider.headers`: actual fetch through response headers, including transport and
  provider service; `provider.body`: bounded response body consumption. Neither
  measures pure model compute. Body is buffered before native response release.
- `model.next` includes all native/model waits; `attempt` includes admission through
  result/failure and cleanup; `cleanup` includes model/MCP/sandbox/delivery shutdown.

These spans overlap (renewal and delivery may run concurrently; container/provider
work is nested in model.next). Use offsets to compare critical boundaries; summing
all durations double-counts work. Fixed-label markers have near-zero durations.
Native/container/provider detail currently covers the contained Codex adapter;
other adapters retain gateway/model-next/sink spans, with no invented native events.

## Missing Hosted measurements

To resolve a future comparable slow turn, correlate its existing occurrence with
Hosted outbox dispatch-attempt start/HTTP ACK, authorize handler duration, first
session/activity receipt ACK and final result ACK. If available, split existing
handler time into DB wait/provider-membership work, without customer content.
Runtime monotonic offsets cannot establish cross-host wall-clock alignment. Saved
ACK→UI label also needs existing per-message UI reconciliation timestamps. A request
for already-recorded safe metadata was sent in the existing Hosted owner thread;
no new prompt, retry or live access is needed to establish what is missing.

## Optional Hosted handler metrics (TIMING-READER-1001)

The runtime reader implements Hosted00847f21's
`docs/customer-agents/latency-measurement.md`. Only collected supervisor callback
spans send `X-Cyrus-Latency-Diagnostics:1`: authorize/admit or renew, progress,
result, interrupt and session delivery. Model/provider/MCP requests do not receive
this header. Disabled collection or a full trace sends no diagnostic header.

A response must have exact `X-Cyrus-Hosted-Timing:1`;401 never supplies accepted
measurements. Parse at most1024 UTF-8 bytes of Server-Timing, at most8 unique metrics:
`cyrus_auth`, `cyrus_body`, `cyrus_event`, `cyrus_admit`, `cyrus_commit`,
`cyrus_callback`, `cyrus_interrupt`, `cyrus_total`. Values use non-negative decimal
milliseconds with at most3 fraction digits, finite and <=600000. Optional descriptions
are exactly `failed` or `capped`; capped requires600000 and means a lower bound.
Unknown metrics/parameters/descriptions, duplicate metrics, invalid numbers, oversize
or missing data make the entire optional header unavailable. Parsing never changes
response success/failure, validation, authority or ACK handling. Old Hosted versions
may ignore opt-in; missing measurements stay absent, not zero.

Each callback span may contain `hosted`, a map of these names to `{durationMs,flag?}`.
No raw headers are retained. Missing metrics are not added. Runtime `durationMs`
continues to measure transport through response parsing/ACK validation; Hosted
metrics measure completed handler stages and are neither pure SQL nor network time.
`cyrus_total` includes its inner metrics, not platform/tunnel time before entry or
response transmission afterward. Keep these clocks separate; do not sum inner
metrics with total or call the residual pure network latency. The reader performs
no residual calculation, interpolation, authority cache or historical reconstruction.
Authenticated failed callbacks may retain fixed failure flags; bad diagnostics
cannot acknowledge an invalid receipt. Existing64x128 trace bounds, opt-in status
retrieval and process-only retention remain unchanged.
