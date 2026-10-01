# Automation latency diagnostics

## Clean greeting baseline (2026-10-01, 09:51 UTC)

The verifier's fresh, empty Linear-only conversation used installed Runtime
`d66ed0a86d0d925fe88469a142da93f640aee416` and Hosted `71edabeef3ab353cc42e92de69990e5db18688ea`.
Occurrence `8f49112fa597b48469e6fb66df1220a69796839ef786d54f7f6cd56c240ebf67`
completed on attempt1 with the correct greeting and no native function calls.
The foreground DOM observer measured60ms optimistic display,5.319s saved-message
ACK, and52.452s to the final response. All128-span capacity was available: zero
spans were dropped. These are existing live observations, not a new author prompt.

| Observed Runtime stage | Time |
| --- | ---: |
| Total dispatch-handler through cleanup | 32.299s |
| Dispatch-handler to native turn/start | 16.696s |
| Admission | 2.282s |
| MCP initialization | 1.633s |
| Five pre-native catalogs, disjoint requests | 9.057s |
| Container initialization | 0.225s |
| Provider response headers + body | 0.539s +0.564s |
| Native completed to Runtime cleanup done | 9.348s |
| All ten catalogs | 17.421s |

The five pre-native catalogs correspond to initial checkpoint access, progress,
the iteration before context retrieval, the post-context check and contained
model entry. Native-context bootstrap still invokes supervisor-owned
`read_context`: zero model-issued tools does not mean zero MCP operations. The
2.331s between its recorded MCP queue entry and the next authority check is
consistent with that source path, but lacks a dedicated tool-duration span and
must not be reported as an independently measured provider call.

The completion tail includes two catalog barriers (3.337s), two receipt-phase
renewals (4.283s), final ordered activity ACKs (0.950s), result ACK (0.550s),
snapshot/local bookkeeping and cleanup. The first catalogs guard native capture
and the pending result checkpoint. Receipt renewal checks current terminal-delivery
authority before final activities and again before the result callback. These
barriers cannot be removed merely because the response text is already available.

The32.299s Runtime span excludes20.153s of the52.452s visible journey. The saved
records do not apportion that difference between Hosted dispatch, tunnel delivery,
and browser refresh/polling; cross-clock `scheduledAt` subtraction is not a
replacement for those spans. The UI's Worked for2s is the existing active-execution
counter excluding authority/delivery waits, not elapsed response time. Responsiveness
remains unaccepted. Source evidence: verifier files
`2026-10-01-bulk-greeting-numeric-timing-095505.json` and
`2026-10-01-71ed-d66-live-greeting-dom.json` in the shared CYHOST-1321 evidence root.

The current bounded improvement proposal is Hosted-owned: combine the catalog's
two serial Linear permission/customer GraphQL reads into one fresh fixed-customer
request, retaining token/account/scope validation and final current SQL checks.
No permission cache, removed invocation check or live improvement is implied.

## Current live acceptance observation (2026-10-01)

Coordinator-reported installed Runtime `39781300` / Hosted `a65f2657`, staging
occurrence `a4077f6f69ddf95cfe13d0c66c1c714a90136b70edf4bbef95b02505c5ed02e2`:
no queued predecessor; native start at 33.698 seconds. At the 111-second observation,
23 catalog spans summed to 65.700 seconds, versus 0.703 seconds to provider headers
and 3.903 seconds for the provider body. The 128-span bound truncated later detail.
Hosted's subsequent observed terminal duration was 165.463 seconds with successful
memory and both source reads. These values were supplied by the active owners;
Runtime did not send another live prompt or inspect live checkpoints.

Responsiveness remains **unaccepted**. Catalog requests are serialized within one
scoped client, but their time overlaps enclosing authority/model spans and can
overlap other activity. Their sum is not automatically total critical-path time.
The exact installed combined/native SQL fixture
pass establishes functional recovery and scope checks; its controlled model and
provider responses cannot establish live speed. Hosted is investigating consolidation
of the same per-request SQL checks, preserving pre-body admission, post-provider
current checks and per-call revocation. No runtime barrier was removed on the basis
of these observations.

The [installed native catalog phase profile](../apps/f1/test-drives/cypack-1546-catalog-phases.md)
measures nine current-authority catalog calls per no-tool greeting, including four
before native start. Increasing controlled MCP HTTP delay150→1500ms increases
warm startup1.351→9.484s without increasing catalog count. Initial discovery is
not duplicated and overlapping periodic checks share an in-flight request. This
isolates transport amplification, not the actual live callsite distribution; no
production barrier was removed or live speed improvement claimed.

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
time from historical wall clocks. By default trace collection never writes durable state. Optional finished-trace retention is described below.
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
retrieval and default process-only retention remain unchanged.

## LIVE-LATENCY-1001: current-authority waits

The passive installed90ff trace records37.304s total. Its MCP/native code is
identical to e978 before this change. No live turn was launched for this review.

| Recorded boundary | Observed interval | Exact90ff path and attribution limit |
| --- | ---: | --- |
| admit response → checkpoint load | 8.880s | Local admission validation/SQLite binding, then awaited `fresh()`. Read-set/channel `fresh()` initializes MCP, sends `notifications/initialized`, reads the catalog, then unnecessarily reads it again. Other scopes renew through authorize. The trace has no renew here, which supports the MCP path; it cannot apportion individual HTTP, local validation or lock waits. |
| model.next → container.initialize | 2.194s | Native adapter awaits current authorization before starting its container. |
| model.request → credential.read | 4.555s | Native callback awaits authorization, captures and persists its native rollout, then broker awaits authorization before reading login credentials. No provider request precedes credential.read. |
| provider headers/body | 0.948s / 0.563s | Actual transport spans; excludes the preceding authorization/snapshot gates and subsequent response-release authorization. |
| native.completed → model.next end | 2.075s | Completion authorization and rollout persistence before returning the model result. |

These are code-grounded candidate components, not retrospective per-component
measurements. Periodic renewal can overlap/join these gates. The older44s intervals
remain unattributed; neither provider compute nor container startup is established
as their cause.

A real SDK regression reproduced the unnecessary second initial `tools/list`.
A new connection now admits one fresh catalog in the same serialized operation.
Every established-session revalidation still makes a new authenticated request.
No cached authority, TTL shortcut, altered renewal/expiry, reference migration,
write replay or changed operation identity is introduced. Snapshot authorization,
provider-access authorization and response-release authorization remain separate:
a durable snapshot can take time, during which authority may be withdrawn.

Additional fixed diagnostic spans (same64 traces/128 spans bounds):

- `ledger.bindCheckpoint`: synchronous SQLite checkpoint-scope binding, including
  any lock wait; failures set only the existing boolean flag.
- `authority.check`: one actual current-authority refresh, including queueing and
  MCP or gateway work. Concurrent callers join that refresh; no fabricated duplicate
  duration is recorded for joiners.
- `mcp.queue`: wait for the per-attempt SDK operation queue (including renew/close).
- `mcp.initialize`: SDK connect/initialize and initialized notification. Optional
  SDK GET rejection can run concurrently; this is not a pure server-handler metric.
- `mcp.catalog`: actual `tools/list` request, response parsing and catalog validation.
- `native.snapshot`: native thread/read, contained rollout capture and durable local
  checkpoint save. No paths, rollout bytes or tool arguments are retained.

These remain runtime transport/local spans, with no Hosted timing request header on
MCP and no model context exposure. They do not affect session execution accounting.
At the cap, missing detail stays missing. Nested spans must not be summed with their
parents.

Controlled reproduction uses the existing native F1 driver with
`{latencyOnly:true, latencyReadSet:true, sessionDeliveryAuthority:true}`. It admits a
Linear customer read-set but the deterministic model greets without calling tools.
This distinguishes **zero tool calls** from **zero source grants**. Injected delays:
150ms per MCP HTTP request,40ms per other Hosted request,80ms provider headers,
120ms provider body. Both cold/warm occurrences use fresh contained native sessions;
“warm” means the same running supervisor/image, not a reused agent/container/session.
The first two runs against installed e978 made20 catalog requests total; the fixed
source run made18. Warm admit-to-checkpoint fell629ms→481ms, consistent with removing
one150ms request. Initial cold measurements724ms→489ms also include host/container
variance; total/pre-native differences are not attributed wholly to this change.
The fixed native model→credentials gap measured two153–158ms catalog gates and a
38–48ms snapshot, directly exposing the serialized work. Final ordered ACKs, zero
tool calls and exactly two result commits passed. Installed exact-head evidence is
packaged separately; these synthetic timings are not live responsiveness acceptance.

## Optional private finished-trace retention

At a future operator-coordinated launch, set BOTH
`CYRUS_AUTOMATION_LATENCY_DIAGNOSTICS=1` and
`CYRUS_AUTOMATION_LATENCY_RETENTION=1` to retain **finished attempts** across restarts.
Both default off; the request header cannot enable either. No new listener, key,
capability negotiation, scheduler table, checkpoint format or model context changes.
No live launch or configuration change is implied by these instructions.

The separate `automation-latency-v1` directory under the runtime's existing Cyrus
home is owner-only0700. Its per-workspace SHA256-named SQLite file is owner-only0600;
occurrence lookup keys are SHA256 digests, not raw workspace/customer/occurrence IDs.
Only the strict fixed span schema and an internal numeric retention timestamp are
stored. The internal keys/timestamp never enter exported diagnostics. The existing
supervisor status route still requires authentication and the diagnostic header,
and only looks up occurrences belonging to its current ledger. The model/sandbox
cannot access this directory. This is diagnostic storage, never an authority store.

Limits:64 latest occurrence attempts,128 spans per attempt,2MiB serialized payload,
4MiB database (plus a bounded transient rollback journal),24h eligibility from save.
Evict oldest on count/byte pressure; expired/future-clock entries are unavailable and
purged on the next store access. No background timer deletes files while collection
is disabled. To erase retained evidence, an operator can remove this directory at
an idle boundary; disabling retention alone does not erase it. SQLite secure-delete
is enabled; ordinary retention is not a forensic secure-erasure guarantee.

A completed attempt saves only after execution/cleanup finishes. Synchronous FULL
SQLite commit makes a successful save survive process restart; it is outside the
reported attempt span; disk work can briefly block the supervisor, so this optional
diagnostic mode is not a zero-overhead measurement. Status reads the bounded store
once for all requested occurrences. The separate diagnostic transaction never waits on another
writer (`busy_timeout=0`). Corrupt/oversized data, unsafe ownership/modes/symlinks,
locks or I/O failure make diagnostics unavailable; they cannot fail or replay work.
There is no guarantee of diagnostic delivery under disk failure or contention.
A crash before finish/save loses that attempt's trace; no duration is reconstructed
from a checkpoint or wall-clock gap. Higher attempt numbers replace older ones;
stale writers cannot overwrite a retained newer attempt or extend its retention.

After restart, an available snapshot has `retention:"private-disk"`; otherwise its
numeric span fields are identical. In-process snapshots retain `process-memory`.
A newly claimed attempt starts fresh and never imports saved spans, queues or
execution state. Missing diagnostics remain absent, not zero. Session execution
counters, admission, revocation, provider/MCP checks and final ACK barriers are
unchanged.
