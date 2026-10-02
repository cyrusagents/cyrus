# Cyrus session/activity persistence dependency

This extends CYPACK-1546 / PR1507 and CYHOST-1321 / PR1102. It does not replace
the [automation contract](runtime-automations-v1.md), its single SQLite scheduler,
current-authority checks, contained MCP connections or terminal receipt recovery.
Hosted accepted the delivery path/envelope in coordination comment
`d15d1384-5393-4440-ada6-2217d57c63c8`. Shared exported types and strict validators
now live in `packages/edge-worker/src/sinks/session-delivery.ts`. Registered automations negotiate and use this transport as described below; native
Codex and investigator child execution now have controlled native-container coverage;
joint live model/hosted UI acceptance remains open. The bounded signal
metadata subset below was accepted in comment `3f8623c3-609a-4199-9e9e-31f549be1b47`.

## Identity and delegation

Both direct and ticket-backed delegation are supported acceptance requirements.
They share `CyrusAgentSession`, `AgentSessionManager` and `AgentActivityContent`.
A direct child has its own Cyrus ID and `parentSessionId`; no Linear issue,
Linear session or Linear credentials are required. A ticket-backed child also
has optional `issueContext` and `externalSessionId` associations. Ticket assignment
remains useful for ownership, review and tracking. Existing production associations
are not removed, migrated or detached by this change.

Harness-native resume identity remains separate (`codexSessionId`,
`claudeSessionId`, `geminiSessionId`, `cursorSessionId`, `opencodeSessionId`). A
native thread ID is neither the Cyrus session ID nor a credential. Resume must
validate the original execution scope and current authority before loading native
state; presenting a persisted ID never authorizes resumption.

`ICyrusSessionSink` extends the activity-posting portion of `IActivitySink` and
adds `createCyrusSession(descriptor)`. It does not require the legacy
`createAgentSession(issueId)` method. Existing `LinearActivitySink` and its
interface remain compatible. The descriptor contains a supervisor-admitted
`scopeRef`, role, Cyrus ID, optional parent and optional external associations.
The sink must independently authorize these against its bound scope, including
the parent's visibility and child-role permissions. Parameters never mint scope.

`AgentSessionManager.createOwnedSession` awaits that admission before tracking a
runner. Its explicit `activitySinkBinding` survives serialization and selects the
Cyrus destination instead of an optional Linear association. Rebinding to another
sink ID is rejected. This internal API does not expose a launch/delegation route,
grant native tools, or by itself implement hosted authorization or durability.

## Inspected baseline and normalization coverage

| Harness | Normalized events already present | Persistence limitations |
| --- | --- | --- |
| Claude | SDK messages, tool use/result, final result/error through AgentSessionManager | Optional `HttpSessionStore` mirrors SDK-native entries to hosted `claude_session_entries`; this is not the normalized session/activity timeline. |
| Codex | SDK/app-server backends normalize thread, item start/completion, turn completion/failure; `CodexEventMapper` emits tool use/result and terminal messages | Contained registered Codex persists its private native rollout and emits source-keyed tool start/result, final response and native lifecycle identity through the durable sink. Reasoning items are not used to fabricate timeline content. |
| Gemini | `geminiEventToSDKMessage` maps tool use/result and success/error; runner accumulates text deltas before normalized delivery | Existing formatter/adapter tests are not hosted persistence or live-session evidence. |
| Cursor | SDK tool_call plus assistant/user blocks map tool use/result; status and exposed thinking have existing handlers; runner produces terminal outcomes | Coverage concerns emitted SDK content only, not inaccessible reasoning. No hosted ordered acknowledgement/replay wired. |
| OpenCode | step_start, tool_use, text, step_finish map init, tool lifecycle and result; runtime failure path emits error outcome | Existing replay/manager tests cover mappings, not a real hosted resumed session. |

Baseline `AgentSessionManager` serializes message handling in memory. Both
normalized-entry delivery and convenience activity posting previously skipped
any session without `externalSessionId`, even with a sink. They catch and log
delivery errors. Buffered final assistant text, activity acknowledgement and
parent-return delivery are not one durable transaction. `LinearActivitySink`
also returns an empty result for unsuccessful activity creation. These are
persistence gaps; do not mistake the presence of a normalizer for reliable
delivery or treat a logged failure as an acknowledgement.

## Shared delivery contract and ownership

CYPACK owns normalized emission, a private scope-bound durable outbox, ordered
replay, lifecycle emission and reconnect. CYHOST owns session/activity rows,
authorization, idempotent ingestion, retention/redaction policy and timeline UI.
The existing linked issues are the shared dependency; no second customer-only
transcript ontology or scheduling ledger is needed.

Accepted supervisor transport is POST `/api/agent-sessions/v1/deliver` on the
existing registered connection. Supervisor credentials remain outside model,
MCP context and checkpoints. Each request carries current attempt/fence authority
plus a stable session-bound delivery item; refreshed attempt credentials must
not change the item's identity or payload. Agreement on this route does not mean it is already deployed or authorized
merely by runtime registration.

Delivery item: `{sessionId, sequence, kind, payload}`; sequence starts at
1, is allocated durably by the runtime, and is immutable across retries. Kinds
are session creation, activity (existing `AgentActivityContent` and
`ActivityPostOptions`), and lifecycle update (existing `AgentSessionStatus`,
optional harness/native identity). Parent creation precedes child creation.
Hosted must reject a sequence gap and a reused sequence with changed payload;
an exact duplicate returns the same durable acknowledgement. Runtime deletes
pending items only after matching acknowledgement. The envelope is exactly
`{contractVersion:1,instanceId,automationId,revision,occurrenceId,attemptId,fence,item}`.
ACK is `{contractVersion:1,sessionId,sequence,digest}`; the digest is SHA256 of
recursively key-sorted JSON of the item, preserving array order and rejecting
undefined, nonfinite numbers and non-JSON values. Lifecycle payload is
`{status:AgentSessionStatus,harness?:{type,sessionId}}`. Activity payload is
`{content:AgentActivityContent,options?:ActivityPostOptions}`. No client-supplied
digest substitutes for hosted computation. Items are bounded to128KiB and display
text fields to32768 characters.

The accepted initial metadata subset accepts only
`signal:"select",signalMetadata:{options:[{value:string}]}` (1–20 choices,
maximum1000 characters each). auth/stop/continue carry no metadata; credential
URLs and other arbitrary metadata are rejected. Existing legacy Linear sinks are
unchanged. This queue is transport
state, not an alternative work scheduler.

Current authority is checked on every ingest/reconnect. A bounded, explicitly
authorized terminal-receipt path can reconcile already-committed records after
execution stops; it cannot append new tool work or resume a revoked harness.
Workspace/customer namespace and parent access are resolved from admission,
not arbitrary payload IDs. Read/list/UI access applies the same tenancy rules.
Persist only approved normalized display fields: no raw config, environment,
provider tokens, MCP authentication headers or opaque full SDK objects. Apply
redaction before local durable storage and revalidate at hosted ingestion.

Ephemeral activities retain existing semantics: ordered delivery with dedup,
but only the latest ephemeral display state is shown; it is replaced by a later
activity and is not promoted into permanent narrative history. Signals keep
the existing auth/select/stop/continue vocabulary. A lifecycle update must not
pretend to be an assistant thought. Parent results/findings/PR references use
the same activity/session relationship and require durable idempotent handoff.

## Runtime adapter and recovery boundary

`SessionActivityJournal` persists redacted normalized items in a private SQLite
file selected by the authenticated operating workspace and namespace. Its
transactions allocate contiguous per-session sequences and remove pending items
only after a matching digest/sequence acknowledgement. Parent creation must be
acknowledged before local child creation. Separate child journals use the current
hosted parent-link creation ACK, without opening the parent journal. An unacknowledged session cannot emit
activities. A denied session does not prevent delivery for another admitted
session; order remains strict within each session. The journal holds at most512
session identities,1024 pending items and16MiB; exhaustion fails closed. Automatic
retention/compaction policy remains to be agreed before long-running rollout.

`DurableCyrusSessionSink` redacts whole affected display fields before storage,
using recognizable credential patterns and supervisor-supplied current secret
values held only in memory. It never changes persisted retry payloads. The
`HttpSessionDeliveryTransport` uses fixed HTTPS, current supervisor credentials,
bounded responses/timeouts and redirect refusal. Recreating a known session
still performs current-authority remote admission; a local receipt alone cannot
authorize reconnection. Reconnect explicitly flushes the queue through the
supervisor lifecycle; the journal is not a scheduler.

AgentSessionManager emits shared lifecycle status/native identity through the
owned sink. Local durable-storage or schema failures stop the owned runner;
network failures retain already-durable items. Owned state serialization requires
the explicit sink ID, omits raw SDK/tool caches and is excluded from the legacy
platform-wide state snapshot. Restoring another sink's state is rejected and
the sink must be rebound. Legacy Linear-backed state handling remains compatible.

Owned children never call the legacy parent-resume callback: that callback may
launch an unscoped runner. Child response plus terminal lifecycle and the admitted
parent relationship provide the persisted result; hosted must wake the parent via
its authorized binding/outbox into the same generic runtime occurrence ledger.
Hosted owns that parent wakeup. Registered root and investigator child occurrences flush
their journal on reconnect and before result completion. Native dynamic-tool requests and durable operation results use stable runtime
operation/source keys across private native rollout recovery. Other native built-in
tool timelines and full engineering execution remain separate coverage gaps.

The production classes are tested together over actual HTTP with a controlled
receiver and SQLite, including normalizer replay, missing ACK, changed attempt,
revocation, bad ACK, separate customer/workspace journals, redaction and both
optional-ticket shapes. No live Codex process or hosted SQL/UI is claimed by
those tests. Registered root execution now negotiates the agreed optional
`sessionDelivery` field using `X-Cyrus-Session-Delivery: 1`, pins its descriptor in
checkpoints, emits stable step-keyed normalized actions/results/lifecycle, and
requires exact final ACKs before `/result`. The new registered F1 is controlled
transport evidence. The native Codex variant now executes real app-server processes
in Docker with synthetic model Responses and real SDK MCP. Actual hosted SQL/UI
and the existing live ChatGPT connection remain separate gates.

## Acceptance still required

- Direct parent plus investigator/engineering children: no Linear creation or
  credential dependency, bounded child scope, separate native identity, durable
  activities/result and current-authority resume.
- Assigned-ticket delegation: preserved issue/parent linkage, same containment,
  returned findings/PR, existing Linear activity regressions.
- Lost activity ACK, reconnect/restart, duplicate/out-of-order delivery, revoked
  authority, cross-customer/workspace reads, rejected parent links, redaction,
  ephemeral replacement and terminal/error ordering.
- Real Codex tool activities and final response persisted by CYHOST and visible
  after UI reload/runtime reconnect. Normalizer replay cannot satisfy this gate.
  Other supported harnesses need their corresponding coverage; current scoped
  automation model readiness remains limited as documented, with no fallback.
- Instruction/tick and admitted Slack/Linear event acceptance remain required.
  No release, production enablement or unrelated live provider effects follow
  from the addition of these shared interfaces.
