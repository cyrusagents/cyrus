# Registered runtime automations v1

This is the current CYPACK-1546 / CYHOST-1321 implementation contract, agreed through
issue comments after Connor's September 29 architecture and `/mcp` direction. It
supersedes the standalone customer-runtime URL/global-model product path and crossed
storage proposals. No release/minimum published version, production enablement or
live provider authority is implied. Historical 269e containment evidence is retained;
it does not accept this redesign.

## One owner per concern

| Concern | Authority |
| --- | --- |
| Generic definitions, applied revisions/tombstones, instruction dedup, clock occurrences, execution leases | CYPACK `AutomationLedger`, private SQLite in `automation-ledger-v1/<workspace hash>.sqlite`; BEGIN IMMEDIATE and synchronous FULL persist before execution |
| Tick generation, queue draining, attempts and execution | CYPACK `AutomationRuntime`; one scheduling algorithm, periodic 15s wake and explicit authenticated wake |
| Private execution checkpoint, pending immutable tool/result | CYPACK `AutomationCheckpointStore`, separate `automation-checkpoints-v1`, never a native session/memory path |
| Customer binding/desired revision, operator/provider inbox, reliable definition/enqueue delivery | CYHOST binding/outbox; outbox retries preserve the original event ID/body |
| Registered supervisor ownership across machines/copies | CYHOST 90s owner lease/generation, random runtime instanceId per boot; no live-owner takeover |
| Customer scope, coordinator write fence, policy, provider credentials, operation receipts | CYHOST existing authority/action ledger, reused by admission and `/mcp` |

Hosted cron may deliver/reconcile an outbox and wake the runtime; it must not create
clock occurrences or run a competing model loop for migrated automations. No CYPACK
module imports customer tables. Non-customer work uses the same generic definition,
ledger and authority adapter. SQLite is the generic durable store, not a replica of
a second hosted automation scheduler.

## Registered transport

Routes mount on `SharedApplicationServer`, both active EdgeWorker and repository-less
WorkerService setup/idle modes. Existing cloud droplet/self-host tunnel registration
and `Authorization: Bearer <CYRUS_API_KEY>` are reused. Hosted resolves that endpoint
through its existing registered-runtime infrastructure/webhook resolver. No new
hostname, port, customer-runtime URL or model key is required.

Handler/lifecycle choice: the existing shared server's route registration convention
already supports generic occurrences, so no new chat/ticket Handler subclass is needed.
`registerConfiguredAutomations` creates the contained runtime and `registerAutomationRoutes`
mounts its authenticated handlers. Server onReady starts polling; onClose aborts/drains
execution before closing SQLite. Both active and repository-less modes use this path.
Instruction/tick F1 setup uses real HTTP definition/enqueue/status requests to these
handlers, not a second dispatch engine. Customer policy remains solely in Hosted.

| Route | Request / response |
| --- | --- |
| GET `/api/automations/v1/capabilities` | Authenticated readiness, exact configured target/adapter, contract 1 and isolation flags |
| POST `/api/automations/v1/definitions` | `{contractVersion:1,definition}` -> `{contractVersion:1,automationId,revision,state}` |
| POST `/api/automations/v1/occurrences` | `{contractVersion:1,automationId,revision,eventId,input,trigger?:"instruction"|"event"}` -> `{contractVersion:1,occurrenceId,status}` |
| POST `/api/automations/v1/wake` | Exactly `{contractVersion:1}` -> 202 accepted; never accepts customer/scope/model selectors |
| GET `/api/automations/v1/status/:automationId` | Applied definition and persisted occurrence statuses; supervisor-authenticated, not an agent tool |

Registration is a strict object: `id,workspaceId,ownerId,namespace,scopeRef,revision,
state,role,instruction,schedule,target`. Identity fields are immutable after first
registration. `scopeRef` is opaque. It does not grant customer access: Hosted must
match an assigned binding, current desired revision, role, namespace and authorized
event before admission. Definitions contain no grants/provider tokens/MCP configs.
Target is `{harness,model}` and must match the compatible configured runtime.

State is enabled/paused/deleted. Same revision+same body is idempotent; same revision
with different body or lower revision rejects. Pause/delete/edit are new revisions
that invalidate queued/running old model work. Pending terminal receipts survive with
their immutable original definition and checkpoint identity. Delete retains a tombstone and cannot be
resurrected. Enqueue rejects changed payload under an existing event identity.

## Scheduling, recovery and bounds

Initial schedules are null or `{intervalSeconds,anchorAt,timezone}`. Interval is
60..31536000 seconds, anchor is ISO8601 UTC, timezone must be valid IANA. Timezone is
descriptive for this elapsed-time schedule; no calendar/DST cron promise. Manual and
provider events carry durable event IDs. SHA256 occurrence identity binds workspace,
automation, revision, trigger and event ID or interval slot. The original payload is
persisted before claim; a model cannot choose clock/occurrence identities.

Missed intervals coalesce to the latest one, with at most one queued tick. Explicit
instructions keep FIFO order. Paused intervals are not replayed after a revisioned
resume. SQLite transactions serialize duplicate ticks/claims across connections.
Limits: 32 queued per definition, 2 executing per workspace, one executing per namespace
in this initial conservative implementation, 3 attempts, 90s local lease, 5s authority
renewal, 5s then 10s retry delay, 24 model/tool steps. Storage is bounded to 1000 definitions
and 16MB ledger state; capacity rejects new writes, never evicts dedup/tombstones silently.

Every process generates a fresh nonpersisted `instanceId`. SQLite fences protect one
store; they cannot protect copies on other machines. Hosted must enforce its registered
workspace/runtime owner lease on every admission/callback/MCP request. A different live
instance is denied. Expired/explicitly relinquished ownership advances Hosted generation
and invalidates old grants. Registration-key replacement also revokes previous ownership.
The supervisor supplies identity; only Hosted can grant current ownership. This prevents
accidental duplicate instances, not a compromised host administrator with runtime secrets.

An unavailable authority/model/MCP endpoint interrupts execution; no offline effects or
legacy fallback. Expired claims receive new attempt/fence. Resume always reauthorizes.
Checkpoint identity binds definition, namespace/workspace, revision, occurrence and input;
it excludes attempts, renewable leases and MCP credentials. Pending tool/result and its
immutable key persist before send. Uncertain effects reconcile with that key on another
attempt, never a new send identity. Completed-result recovery opens no model/progress/MCP
session. Missing terminal checkpoints fail closed. Before first result send, the same SQLite
ledger durably marks the occurrence as receipt-only, retaining its original definition
and a separate three-attempt receipt budget. Pause/edit/delete and model unavailability
cannot cancel this reconciliation. Current supervisor registration/ownership and Hosted
receipt authority remain mandatory. Receipt claims cannot reopen model, progress or MCP
work; exhausted receipts stay blocked. No second queue engine or scheduling ledger.

## Native remembered context and work

The optional [native-context contract](runtime-native-context-v1.md) adds bounded,
coordinator-only context reads and action tools on the same registered `/mcp`
connection, including source-free runs. Hosted retains data and current-authority ownership.

## Admitted event inputs

The additive event discriminator/capability proposal has been sent to the Hosted owner;
its exact wire acknowledgment and connected use remain an integration gate. Existing
instruction bodies and identities remain compatible. Do not enable the new event
discriminator against a Hosted callback schema that has not accepted it.

Operator instructions and provider events share the authenticated occurrence handler.
Omitted trigger defaults to `instruction`; `event` is explicit for already-admitted
provider input. Stable SHA256 identity includes workspace, automation, revision,
trigger and opaque eventId. Discovery advertises `eventInputs:true` and
`harnessStreaming:false`; old runtimes must fail capability validation before event
delivery rather than ignore the new field or select a legacy runner.

Delivery is arrival FIFO within a namespace. Source timestamps do not reorder an
already-running turn; duplicate IDs retain the original payload and changed payloads
under the same ID reject. Backoff reserves namespace order. The current contained
Messages adapter queues a new occurrence and never injects events into active model
messages. Another authorized namespace can fill the remaining workspace slot.
SQLite persists arrivals while execution is active; Hosted outbox retains delivery
while the registered runtime is offline. Pause/revision/revocation prevents pending
model work from regaining old authority; terminal receipt reconciliation remains separate.

CYPACK accepts no provider/customer/channel/issue selector in this envelope. CYHOST
alone interprets existing signature-verified ingress, resolves exact mappings, applies
subscription/type policy and admits the immutable event input. Unmapped or ambiguous
sources must not be routed, and a channel notification cannot broaden a thread grant.
Runtime F1 uses synthetic admitted Slack/Linear inputs; it does not verify provider
subscriptions/signatures or claim that every notification type is supported. Final
acceptance requires Hosted's exact event/subscription inventory and connected ingress
proof, in addition to the instruction/tick milestone.

## Supervisor admission and callbacks

Fixed existing `CYRUS_APP_URL`, HTTPS only, no redirects. Each callback uses existing
runtime Bearer plus `X-Cyrus-Team-Id`; neither enters model messages or MCP transport.
There is no Hosted generic `/claim` or HTTP `/tool` endpoint in this final contract.

POST `/api/automations/v1/authorize`:

```text
{contractVersion:1,instanceId,automationId,revision,occurrenceId,attemptId,fence,
 definition:<registration>,
 occurrence:{id,trigger:"instruction"|"event"|"tick",scheduledAt,input},
 phase:"admit"|"renew"}
```

Hosted compares against assigned durable work and current configuration; it MUST NOT
mint arbitrary scopes from these fields. Response is exactly:

```text
{authority:{contractVersion:1,definition:<registration plus grants>,occurrenceId,
 attemptId,fence,leaseUntil,phase:"execute"|"reconcile",input},
 mcp:{token,audience:"/mcp",expiresAt,grantId}}
```

Lease/token times are ISO8601 UTC; token cannot outlive lease. Authority identity/input
must match registration/claim. Each resource grant is `{id,connectionId,accountId,
resource,permissions}`. `id` is stable per occurrence; `mcp.grantId` binds the primary grant and each returned `items[].grantId` binds the grant selected by the fixed tool name.
Only the token hash/expiry rotates; a grant identity change during renewal is denied.
Resource is `{provider:"linear",teamId,issueId}`,
`{provider:"slack",channelId,threadTs}`, or the negotiated customer read-set binding
`{provider:"linear",customerId:<UUID>}`. Each occurrence supports 0/1 authenticated
binding, or the explicitly negotiated ordered pair described below. A customer read-set binding enumerates session-confined issue references;
Hosted derives the current issue set from verified provider associations. Permissions read/write/delegate do
not bypass coordinator role or Hosted approval. The delegate permission is returned only
when both delegation and session-delivery negotiation headers are present. Hosted renews only current ownership,
revision, policy/account state. Changing authority requires a new definition revision.

POST `/api/automations/v1/progress` carries `{contractVersion:1,instanceId,
automationId,revision,occurrenceId,attemptId,fence,status:"running"}`.
POST `/api/automations/v1/result` carries the same identity plus `{idempotencyKey,text}`
instead of status. Ack is exactly `{contractVersion:1,acknowledged:true,occurrenceId,
idempotencyKey}`. Hosted stores the immutable receipt and may admit phase reconcile
after result commit/ACK loss; no model reopening or renewed provider rights.

### Negotiated owner interruption

Runtime advertises `ownerInterruption:true` and sends
`X-Cyrus-Owner-Interruption:1` on authorize. Hosted opts in with the optional
top-level admission field `ownerInterruption:true`; otherwise omit it. The flag
must remain unchanged across renewal. Older strict runtimes must never receive it.
No model-facing field or scope authority is added.

After failed **nonterminal** execution, runtime first aborts and quiesces model
callbacks/native process, MCP operations, engineering container, authorization
renewal and activity delivery. Native cleanup proves its uniquely named container
is absent with a successful Docker listing, including when `--rm` removed it
already. Daemon/removal uncertainty, pending callbacks or any cleanup failure
prevent release. Settled activity delivery may leave durable unacknowledged items;
their immutable replay remains required, and no more delivery may be in flight.

Only then, with affirmative negotiation, POST `/api/automations/v1/interrupt`:

```text
{contractVersion:1,instanceId,automationId,revision,occurrenceId,attemptId,fence}
```

It uses the existing supervisor transport and the exact admitted owner tuple.
Hosted atomically checks current registration and exact admission owner, revokes
only that run/grant/MCP session and ends that lease. Strict immutable ACK:

```text
{contractVersion:1,occurrenceId,attemptId,fence,acknowledged:true}
```

An exact replay returns its saved receipt without affecting a replacement owner.
Foreign/stale identity and completed/result-committed execution cannot be released
or reopened. Runtime does not interrupt terminal checkpoints or result-ACK recovery.
A transport failure retries the identical tuple once (each request bounded to
15 seconds). Denial, malformed/foreign ACK or exhausted transport failure stops
release attempts and preserves the original execution diagnostic and ordinary
lease recovery; it never resets budgets or invents an ACK.

The existing bounded queued retry still rechecks current Hosted authority and
preserves input, checkpoint, pending tool payload and write operation keys. Pause,
revision change and revocation can deny it. Crashes/unacknowledged releases may
still require explicit operator recovery after lease expiry; no new scheduler,
automatic blocked-work reset or guessed Hosted lease deadline is introduced.
Hosted owns SQL/current-owner/revocation enforcement; connected SQL/HTTP tests
remain necessary in addition to runtime controlled fixtures.

## Real MCP, fixed authority parameters

Only `https://<same configured hosted origin>/mcp`, never `/api/mcp`. Real MCP SDK
Streamable HTTP performs initialize, initialized notification, tools/list, tools/call.
Responses are JSON-only and buffered with a 2 MB/20s bound before SDK consumption.
Optional streaming GET405 and notification-body cancellation cannot leave an unhandled
network-stream rejection; oversized, aborted and non-JSON streaming responses fail closed.
Authorization is the short-lived scoped Bearer on **every** HTTP request; session ID
is protocol state, never authorization. No OAuth/browser login, global MCP config,
provider token, native fallback or model-selected endpoint. Renewal rotates the token
hash/expiry under a stable grantId. Runtime serializes the entire initialize/list/call
operation with supervisor renewal, including the server-side rotation request. Each
HTTP request pins its admitted credential. Without negotiated session renewal,
rotation initializes a new session; negotiated renewal below retains the exact session. No token/session ID is checkpointed. The lease abort deadline remains
active while renewal waits (each MCP request is bounded to 20s); expired/revoked
credentials are never kept valid for a pending call. Server authorization on every
request remains mandatory. Interrupted writes keep the same pending operation key
for reconciliation, with no transparent retry.

Thread-bound catalog: `read_messages({limit?,cursor?})`, `reply({text})`.
Issue-bound catalog: `get_issue({})`, `add_comment({text})`.
Read limit is 1..100, cursor bounded 2000 chars, text 1..10000 chars. All objects strict.
No workspace/customer/account/connection/channel/thread/issue/role/run/grant/action
argument. Arbitrary provider IDs, aliases, HTTP/shell and absent tools deny.

### Customer-derived read sets

Runtime advertises `customerReadSet:true` and sends `X-Cyrus-Customer-Read-Set:1`
on authorize/renew. Hosted must gate this resource variant on negotiation; old
runtimes cannot parse or dispatch it. Published Hosted contract
`0e37517391a930c83ff42a24f80b332b1ee82c10` defines `list_issues({})` and
`get_issue({reference:<UUID>})`. Fixed issue `get_issue({})` remains unchanged.
All schemas reject undeclared fields. The model sees no customer ID or provider ID.
The standard result envelope retains the authenticated customer binding; its
`text` for list is JSON `{issues:[{reference,identifier}],held}`. Runtime validates
this shape and remembers references only within the initialized MCP connection.
Hosted checks current grant and provider association before returning content.

References expire on reconnect and on credential rotation without the negotiated
continuation below. While the existing lease and
token have more than 15 seconds remaining, runtime's current-authority checks
(including the 5-second poll and model/activity boundaries) use authenticated SDK
`tools/list`. The published Hosted handler revalidates current run, registration
owner, grant, policy, mapping/account and session on this request. This is an
authorization probe, not a lease extension. At the renewal threshold the existing
authorize flow rotates the credential; the exclusive MCP queue serializes this
with in-flight calls. The original absolute expiry timer remains active.

### Negotiated MCP session renewal

`capabilities.mcpSessionRenewal:true` and authorize header
`X-Cyrus-Mcp-Session-Renewal:1` advertise support. Hosted opts in with optional
`mcp.sessionRenewal:true` on initial admission. Without that acknowledgement runtime
sends no new body fields and retains the legacy reconnect behavior. This capability
alone is not proof that the connected Hosted implementation supports continuation.

On phase `renew`, runtime may send optional `mcpSessionId:UUID`, taken only from its
currently admitted real SDK transport. Hosted must atomically validate the same
workspace/runtime owner, run/attempt/fence, revision, grant and resource binding,
plus an open unexpired session bound to the previous credential, before rotating
that credential and retaining that exact session. Foreign, closed or expired sessions
and changed authority reject; new attempts cannot inherit sessions. Other sessions
must not gain authority from this operation. All existing renewal budgets apply.

Hosted acknowledges a requested continuation with `mcp.sessionRenewal:true` and
`mcp.sessionId` equal to the requested ID. No session ID is returned without a
continuation request. Missing/mismatched/unsolicited acknowledgement fails closed.
The supervisor serializes renewal with complete initialize/list/call operations,
then changes the admitted transport credential at that idle boundary. Each HTTP
request snapshots it before sending. References remain within the *same* MCP session;
none are mapped to provider IDs, transferred between sessions or restored from disk.
No session ID or credential enters model arguments or checkpoints. The original
lease timer stays active while waiting; revocation and fresh association checks
still apply to every request. Slow model turns may span multiple authorized renewals.
Pending write arguments and operation keys remain unchanged, including lost-ACK
reconciliation. Real disconnect, process restart or replacement attempt clears the
local reference set and requires a fresh listing.

After reconnect an old/unissued pure-read reference yields a bounded instruction
to call `list_issues` again, without accessing a provider. Session references are
not restored from checkpoint text. A pending write/delegation keeps its original
arguments and idempotency key; it is never rewritten with a newly listed reference.
Terminal result reconciliation uses the supervisor admission path, not a completed
MCP session. Loss of current authority stops the contained model.

The customer-bound delegation schema additionally requires `reference`. Hosted's
published slice intentionally withholds this permission until its child narrowing
is implemented; runtime schema support is not acceptance of that future path.
Customer read sets never expose `add_comment` or `reply`. Existing fixed-resource
direct/ticket delegation and separate engineering authority remain unchanged.

The additive delegation contract (Hosted ACK 2a712269, CYPACK ACK 4c0d3718) is
`delegate_investigation({instruction,tracking})`. Instruction is 1..10000 characters;
tracking is required and exactly `direct` or `assigned_ticket`. No parent, role,
resource, issue, approval or operation identity may be supplied by the model.
Only a coordinator with both read and delegate permission discovers/calls it.
Workers cannot receive delegation admission, and child grants remain read-only.
Runtime advertises `delegation:true` only with durable session delivery configured
and sends `X-Cyrus-Delegation:1` alongside `X-Cyrus-Session-Delivery:1` on admission
and renewal. Older runtimes receive no delegate permission; unknown tools/permissions
still reject rather than falling back.

Hosted resolves the connection-bound parent/resource, commits the child assignment
and outbox before acknowledging, and rechecks the original credential after metadata
lookup. `direct` requires no Linear session/issue; `assigned_ticket` associates the
already-bound authorized Linear issue. This tool does not create or assign a provider
ticket; those provider mutations remain separately authorized work. Children execute
through the same registered definition/occurrence/session lifecycle. Hosted owns child
result routing back into a subsequent parent occurrence. Repeated identical delegation
payloads within an occurrence, including after lost ACK or native reconnect, retain one
supervisor operation identity. Different payloads get different identities. Delegation
results use the existing scoped structuredContent envelope, with fixed authority
metadata validated and removed before model exposure.

Supervisor attaches `_meta:{idempotencyKey}` to tools/call. Hosted owns approval/action
selection and exact approved payload comparison. Worker writes deny regardless of token
account breadth. Hosted validates current registration owner, run/attempt/grant, audience,
expiry, lease, revision, role, connected account and exact resource before every call,
including existing sessions. Cursor/pagination can only narrow the bound resource.
Completion, pause, revocation, account disconnect or owner takeover denies further tools.

Tool `structuredContent` is `{items:[{grantId,connectionId,accountId,resource,text}],
nextCursor:null|string,receiptId?}`. Runtime validates all returned identities against
the admitted binding selected by the fixed tool name, then exposes only `{items:[{text}],nextCursor}` to the model.
MCP descriptions/server schemas are not allowed to add callable authority. Provider
credential brokerage and existing Linear/Slack signature verification remain Hosted-owned.

## Containment and configured model readiness

The Messages target is configured harness `claude` with an explicit `claude-*`
Anthropic model ID and the runtime's existing ANTHROPIC_API_KEY connection. Discovery
explicitly names adapter `anthropic-messages-contained-v1`; this is not a claim of
Claude Code OAuth equivalence. Claude OAuth, unsupported harnesses, aliases and missing
connections report unavailable, never silently select a provider/model or accept global
customer-feature keys. No model call occurs merely from registration/discovery.

For the Messages adapter, the model receives scoped messages and strict JSON tool choices only. No native
subprocess, filesystem, shell, network, connector, config/plugin loader, auto-memory,
SDK session or model-provided credential exists in this interpreter. Supervisor model
transport is fixed Anthropic Messages; MCP transport is fixed Hosted /mcp. Private
checkpoint/ledger data are not mounted into any agent. This boundary protects against
malicious model output, not the administrator controlling the runtime host.

Registered engineering uses the assignment-scoped extension below. There is no
fallback from generic automation to the historical standalone service.

## Verification and remaining gate

Run `pnpm --filter cyrus-edge-worker exec vitest run test/automations.test.ts test/automation-mcp.test.ts`, build
the edge-worker, then `node apps/f1/automation-drive.mjs`. F1 uses production runtime,
durable SQLite, model adapter and actual MCP SDK HTTP sessions with controlled authority,
provider/model transports and denied external network. It covers instruction+real tick,
non-customer work, persisted results, lost-ACK restart without reopening work, strict
arguments, open-session expiry/revocation, reconnect, copied-instance denial and secrets
absent from checkpoints. This is not the joint Hosted implementation acceptance.
Independent actual Hosted admission/SQL/MCP, connected-account denial, visible customer
result and current-head UI verification remain required. No production enablement,
live provider/model effects, publication or merge are authorized by these tests.


## Negotiated session delivery and paired bootstrap

The registered runtime advertises `sessionActivities` only when its private journal
and fixed-origin transport are configured. Its authorize/renew requests negotiate
`X-Cyrus-Session-Delivery: 1`; older authorities may omit `sessionDelivery`. When
present, v1 uses `/api/agent-sessions/v1/deliver` and the shared Cyrus session/activity
ontology. The admitted descriptor is bound to scope/role and persisted in the private
checkpoint; renewal or recovery cannot change it or silently remove delivery.

Root creation is acknowledged before model execution. Tool start/result and final
response/lifecycle use immutable source-event keys in the receipt journal. Tool
output is checkpointed before activity emission. Replay retains sequence, content
and digest across attempts. All final items must receive exact ACKs before the
runtime transmits `/result`; lost result ACK recovery replays only identical receipts
and the immutable result, never the model, tools or progress. Display fields use the
shared 32,768-character bound; credentials are redacted before journal persistence.
The bounded journal fails closed when full. It is transport storage, not a scheduler.
Child descriptors require the separate server-admitted binding described below;
neither a parent ID nor role in model text grants execution.

New paired auth responses may include authenticated `config.teamId`. Pending launch
then GETs `/api/config/runtime` with the existing paired API key/team header before
starting workers. It accepts only v1 strict config and allowlisted environment keys,
keeps the selected HTTPS origin and local port/path configuration, and writes private
files with a recovery marker. No scope, tunnel token, API key or origin may be
replaced by bootstrap. Existing configured/unpaired workflows retain their behavior;
old paired installs lacking team ID still need the existing authenticated config
push once. Bootstrap configuration is not proof of contained harness readiness.

### Contained Codex and admitted child sessions

The registered handler also supports `codex-app-server-contained-v1` for an
explicit configured Codex model (tested `gpt-5.5`). It runs the reviewed native
Codex 0.153.3 app-server in a dedicated immutable Linux image. The same-user
supervisor brokers the existing private `CODEX_HOME/auth.json` ChatGPT login to
the fixed Codex Responses endpoint; the container never receives login, pairing,
MCP, or provider credentials. Native `account/read` owns login refresh. API-key
substitution and an uncontained CLI fallback are unsupported.

Set `CYRUS_CONTAINED_CODEX_IMAGE` to a preloaded `sha256:` image ID and
`CYRUS_CONTAINED_DOCKER_HOST` to the same user's local Unix socket. Optional
`CYRUS_CONTAINED_DOCKER_PATH` is an absolute binary path (default `/usr/bin/docker`
on Linux, `/usr/local/bin/docker` on macOS). Startup probes the private login and
actual isolated app-server before advertising readiness; missing image/socket,
image-declared volumes, incompatible protocol, or unavailable login fail closed.
The image has no host mounts, networking, inherited environment, broad MCP, user
plugins, or shared home. It uses a read-only root, private bounded tmpfs, dropped
capabilities, no-new-privileges and CPU/memory/process limits. Native shell,
goals, apps, plugins, hooks, browser/computer, image generation, memory import and
agent spawning are disabled. Built-in patch/image tools can only reach the
container's private filesystem; they confer no repository/deployment authority.

Native rollout bytes and native identity are stored only inside the existing
scope-keyed checkpoint. Recovery restores only that rollout into a fresh empty
container, revalidates current authority, and starts a continuation turn of the
same native session. A captured pending dynamic-tool request is reconciled before
another model call. An interrupted turn's completed tool output is supplied from
the durable operation receipt. Repeated identical write payloads in one occurrence
retain one operation identity across native call IDs; they cannot create a second
write on reconnect. Terminal receipt recovery never starts the harness. Native
identity is a lifecycle association, distinct from the Cyrus session ID.

A server-admitted child definition includes optional `session` using the shared
`CyrusSessionDescriptor`: stable `assignment:<UUID>` ID, mandatory parentSessionId,
matching scopeRef/role, no externalSessionId, and schedule:null. Direct children
omit issueContext. Ticket-backed children carry the server-verified optional
issueContext. Both are separate definitions/occurrences in the same ledger, with
separate private checkpoints/journals and narrower read grants. The exact descriptor
must match current authorize/sessionDelivery and all subsequent renewals. The
hosted creation ACK establishes the admitted parent link before the child's
private journal accepts activities; the runtime never opens the parent's journal
to establish that link. Findings finish the child's own result ledger; hosted
routes them back to the parent. No Linear session or ticket is manufactured for a
direct child. Engineering uses a separate parentless assignment descriptor as
described below; investigator grants confer no engineering authority.

Controlled F1 now covers this native path, including direct/ticket descriptors,
real SDK MCP, instruction/tick/event delivery, reconnect and terminal ACK replay.
Live ChatGPT login/model transport, hosted SQL/UI reload and real assigned-ticket
verification remain separate joint gates. No minimum published version exists.


## Registered engineering assignment extension

Hosted wire ACK 4a96a3c4 and published contract
`c50e1b2a6c4bbf8b41f47e42cda73446059c67b5` add optional authorize-response
`engineering`, beside (not inside) `authority`. Both `X-Cyrus-Engineering:1` and
`X-Cyrus-Session-Delivery:1` are required. Runtime negotiates protocol support even for receipt-only recovery. It advertises
engineering execution readiness only after the configured contained Codex adapter
and a separate isolated engineering executor probe both succeed. No released minimum
version exists; old runtimes receive no engineering envelope and must not execute
an engineering definition through a legacy path.

The strict envelope is `{assignmentId,repository,baseSha,headBranch,reviewId,
generation,revision,operations:["execute","publish"],environment:"isolated",
deployment:"deny",technicalBrief,syntheticReproduction,allowedPaths,files}`.
Assignment/review IDs are UUIDs, base is 40 lowercase hex, generation/revision are
positive safe integers. Brief/reproduction are each 1..20000 characters. At most
500 unique reviewed paths are allowed; files are UTF-8 strings with at most1000
entries and800000 total JSON bytes. Traversal, absolute paths and credential paths
are denied. Every initial file must be explicitly allowlisted. Runtime source
`automations/Engineering.ts` matches Hosted's frozen schema.

Definition ID equals assignmentId; namespace and scopeRef are
`engineering:<assignmentId>`, role is engineering, grants is empty and schedule
is null. The exact session descriptor is `{id:"assignment:<assignmentId>",
scopeRef:"engineering:<assignmentId>",role:"engineering"}`. It contains no private
parent, customer, issue or external session association. Generic journal parent
checks are unchanged. Hosted separately authorizes sponsor/private-parent links
and projects the technical timeline into the authorized customer view. The
2026-10-01 customer release cap permits single-customer engineering handoff only;
Hosted rejects new cross-customer shared-management and production-release work
before admission/dispatch. The generic assignment wire format and historical
receipt/projection records remain compatible; they do not enable those deferred
customer workflows. See [the capped boundary and Slack ingress ownership](customer-runtime-release-boundary.md).

The model receives only the reviewed technical brief/reproduction and permitted
publication paths. Generic registration instruction and occurrence input are not
included in the engineering model conversation. No provider/customer read or
coordinator write/delegation tools exist in this role. The existing supervisor
model broker and private native checkpoint remain isolated from the engineering
computer, which receives only reviewed files through stdin, no host mounts,
credentials, network, plugins or shared memory.

Local `execute({command})` uses the reviewed Node image in a separate disposable
engineering container. Completed nonzero exits return diagnostics and exit code,
persist edited files, and allow repair/retest. Diagnostics are bounded and report
truncation explicitly. Timeout, abort, output overflow and snapshot failure fail
closed and remove the container. Current authority is revalidated before each
operation and after execution; the independent lease deadline remains active.

`publish_artifact({title,summary})` has no IDs or files in model arguments. The
supervisor freezes the actual reviewed-path snapshot into the pending checkpoint
before transmission and supplies only `_meta:{idempotencyKey,engineeringFiles}`.
Operation identity includes title, summary and exact snapshot. Recovery replays
those bytes under current authority, without a new operation identity or rerunning
completed local commands. Hosted ACK `2d7841a9` freezes the strict response union:
`{assignmentId,status:"published",receiptId,publication:{repository,number,url,headSha}}`
or `{assignmentId,status:"uncertain",receiptId}`. Assignment and repository must
match the admitted envelope. Receipt ID is the existing publication action UUID;
number is a positive safe integer, head SHA is40 lowercase hex, and URL must equal
`https://github.com/<repository>/pull/<number>` exactly. Extra fields are rejected.
Only validated published receipts advance the model. Uncertain receipts, transport
failures and malformed/foreign results leave the frozen pending operation intact;
Hosted reconciles its existing expected-commit/branch/PR-marker ledger before
returning success. Provider publication and private sponsor fanout stay in Hosted.

The entire engineering handoff is part of the checkpoint identity. SQLite pins
that identity to the occurrence before effects. A retry with changed generation,
review revision, files or scope cannot create a fresh checkpoint under the same
occurrence. Renewal additionally pins the stable MCP grant ID while allowing token
rotation. Changes require newly admitted durable work. Terminal result ACK recovery
uses existing receipt-only claims and ordered activity flushing, opening no model,
sandbox or publication tool, including when the model/image is unavailable.

The additive private ledger checkpointScope field is fail-closed for older strict
readers. Rollback must disable new engineering dispatch and preserve the new ledger;
do not point an older runtime at it or delete it to bypass pending receipts.


## Safe occurrence failure diagnostics

The authenticated existing `GET /api/automations/v1/status/:automationId` returns
optional `occurrences[].lastFailure = {phase,code,httpStatus?,authorizePhase?,sections?,at}`.
This is persisted in the same private SQLite transaction as retry/block status,
before a checkpoint or session need exist. Attempt/fence are the occurrence's
existing fields. Phases: `admission`, `authorize`, `execute`, `mcp`, `progress`,
`result`. Codes: `http_denied`, `transport_failed`, `response_invalid`,
`admission_invalid`, `identity_mismatch`, `credential_invalid`,
`authority_unavailable`, `session_mismatch`, `mcp_initialization`,
`mcp_authorization`, `mcp_operation`, `execution_interrupted`.
`httpStatus` is a numeric HTTP status only. Schema rejection sections are restricted
to `authority`, `mcp`, `sessionDelivery`, `engineering`, `response`; no untrusted
field names, values, raw error/SQL messages, bodies, stack traces or credentials.
Unknown execution failures receive a generic code. Polling revocation retains the
authority diagnostic even if aborting the model produces a generic abort exception.

The current failed attempt's diagnostic survives restart and exhausted retries.
A fenced stale owner cannot replace it; successful completion clears it.
`authorizePhase` is the fixed request phase (`admit` or `renew`), never a server
response body or arbitrary request text. It distinguishes initial admission/recovery
from an active owner's renewal denial.

`occurrences[].failureHistory` optionally retains at most 16 strict entries, each
containing the same safe failure fields plus numeric `attempt` and `fence`.
The first recorded failure is retained alongside the latest 15 entries so a later
owner-conflict 409 cannot erase the original interruption. History survives restart,
explicit recovery and success; it is diagnostic context, not a current-error flag or
permission to retry. A successful occurrence still clears `lastFailure`.
Older records without history remain readable. No older failure or attempt is
inferred from legacy `lastFailure`; the first recorded entry may therefore be a
later attempt. Discarded historical reasons cannot be reconstructed. Hosted owns
authenticated tenant/customer-scoped status projection and UI copy; no new callback
route or automatic replay is introduced.
Missing checkpoint does not prove admission denial: the initial read-set MCP
initialize/list authorization runs before first checkpoint creation. Correlate
both authorize and initial MCP traces when diagnosing historical runs.

Do not downgrade a ledger written with these optional fields to an older strict
reader. Disable dispatch and preserve the ledger/receipts during rollback; never
strip diagnostic fields by directly mutating a live ledger.

## Explicit operator recovery

`capabilities.operatorRecovery:true` negotiates the additive authenticated
`POST /api/automations/v1/retry` route on the existing registered runtime. Hosted
must check capability and current workspace/customer/operator authorization before
calling it; an old runtime's missing capability/route never falls back to enqueue,
new instruction, legacy runner or direct database mutation. The command is not a
model/MCP tool and receives no supervisor credentials through agent context.

Strict request:

```json
{"contractVersion":1,"workspaceId":"registered-workspace","automationId":"original-automation","revision":2,"occurrenceId":"original-64-character-hex-id","commandId":"operator-command-uuid","expectedFence":3}
```

`commandId` is a server-managed UUID durably retained by the operator action across
lost acknowledgements. `expectedFence` comes from the exact blocked occurrence's
status. No replacement input, role, resource, customer/grant, model, checkpoint,
operation key or budget is accepted. Registered-runtime Bearer authentication is
unchanged. Invalid auth401, malformed request400, unavailable/conflicting scope or
state409. A new command requires the current enabled definition/revision, matching
paired workspace and exact blocked occurrence/fence, with no active local lease.
Queued/running/completed/cancelled, paused/deleted/stale-revision and cross-scope
commands deny. A current Hosted lease owned by another attempt still denies
execution at admission; the operator must not treat202 as a lease takeover.

Immutable202 receipt echoes all request fields plus
`{cycle,maxAttempts:3,status:"accepted",acceptedAt:<ISO UTC>}`. In one SQLite
transaction the runtime records that receipt and moves only blocked work to queued,
setting a cycle baseline and availableAt. It preserves the original input, trigger,
scheduledAt, ordering, occurrence ID, checkpoints/native state and pending tool/result
operation keys. Lifetime attempts and fence never reset; the next ordinary claim
increments both and creates its attempt ID. New cycle max3 claims includes any
transition to terminal receipt recovery, using existing5s/10s retry delays. No
wake, restart, duplicate enqueue or command replay automatically resets a budget.
Expired owners consume the same cycle budget. Explicitly recovered queued ticks
are not cancelled by ordinary later-tick coalescing.

An exact accepted-command replay returns its original receipt without modifying
state or budget, including while running or after completion/exhaustion. A new
command against those states denies; after another exhaustion only a new explicit
command with the new observed fence can open a cycle. Reusing a command UUID with
a different request denies across the workspace. Command records survive process
restart and serialize across SQLite connections. Storage fails closed at10000
accepted command records; records are not silently pruned or command IDs reused.

Acceptance queues recovery; it does not authorize an execution. The ordinary
Hosted admission path rechecks current runtime ownership/lease/revision/policy and
scope before model/tool/session effects. Every newly admitted occurrence now pins
its checkpoint scope before effects (previously engineering-only); recovery cannot
switch an already pinned grant/resource into a new checkpoint. Terminal receipts
retain their committed scope and recover result ACKs without model/tool reopening,
including when the configured model is unavailable. No authority is inferred from
an operator-provided parameter. Existing pre-upgrade ledgers load without mutation
of occurrence identity; historical unpinned checkpoints still depend on Hosted's
immutable occurrence grant contract. No automatic migration guesses private scope.

Hosted owns operator-action persistence, customer checks, status/UI projection and
explicit live invocation. Runtime owns the atomic command receipt and bounded
execution cycle. Rollback disables dispatch and preserves new ledger/checkpoint
fields; older strict readers must not open the upgraded ledger. Neither publishing
this contract nor building its artifact authorizes a live retry or deployment.


### Negotiated execution duration in session lifecycle

Runtime `capabilities.sessionExecutionTiming:true` is available with durable session
delivery. Authorize requests send `X-Cyrus-Session-Execution-Timing:1` alongside
`X-Cyrus-Session-Delivery:1`. Hosted opts in with **top-level** admission field
`sessionExecutionTiming:true`, leaving the immutable `sessionDelivery` descriptor
unchanged. Admission/renewal cannot change this opt-in within an attempt. No timing
fields are sent to an old server that omits the acknowledgement. A journal already
containing timing requires the opt-in on resume; it cannot rewrite immutable items
for a receiver that loses support. No scheduler or authority scope changes.

Negotiated lifecycle payloads may add a pair (both present or both absent):

```ts
executionDurationMs?: number;       // integer, 0..Number.MAX_SAFE_INTEGER
executionDurationComplete?: boolean;
```

`executionDurationMs` is cumulative **observed execution across attempts of this
occurrence/session**, including failed and retried work. Model generation and tool
calls (including their provider latency) are measured; queue, retry/backoff, offline,
operator wait, initial admission, progress, activity delivery and result receipt
waits are excluded. Blocking supervisor authorization/native identity delivery
inside the native model invocation is also excluded. Each child measures its own
work; parent duration never sums child durations or waiting for child results.
This is elapsed time within the measured calls, not CPU time. The first model call
also includes contained process initialization and local checkpoint work; it does
not represent provider generation alone. Concurrent background
work is not subtracted when it overlaps a measured call; only explicit blocking
exclusions are subtracted. Native Codex task duration includes time waiting for
supervisor tool replies and can be substantially longer. Its time-to-first-token
also includes the login broker's bounded response buffering; it is not a pure
provider latency measurement. Do not subtract either metric from this counter to
infer a precise breakdown without stage timestamps.

Session creation still requires a current-authority remote ACK before execution.
Scoped runtime intermediate activity/lifecycle items are durably appended locally,
then delivered in order by one bounded background drain. Model/tool execution does
not wait for these intermediate ACKs. Every delivery rechecks current authority;
terminal result publication still waits for all immutable receipt ACKs. Abort stops
the drain before closing its journal; undelivered items remain for authorized
recovery. Existing sink consumers without background delivery keep eager delivery.

Before native turn/start, runtime admission, MCP initialization/current-authority
checks, session creation ACK, progress, container startup and native initialization
are sequential boundaries. There is no fixed 52-second startup sleep. A scheduled
or admitted timestamp alone does not apportion these stages or any preceding queue
wait; receipt timestamps and native events provide only boundary observations.

The existing action/tool/response activity ontology and ephemeral semantics do not
change. These fields are supervisor measurements, never model arguments/content.

Intervals live in the private SQLite session journal under the existing workspace
and checkpoint scope. Each interval records attempt, model/tool kind, wall-clock
observation metadata and a **monotonic-clock** duration. Wall timestamps are not
subtracted to compute elapsed time. Start, completion and interruption persist
synchronously; active intervals are durably sampled every five seconds. Fencing
rejects earlier attempts' timing writers. Controlled interruption closes the interval
at observed cancellation, rather than counting cleanup or later retry delay.

A process crash cannot yield an exact unobserved tail. Recovery closes an abandoned
interval at its **last durable sample**, preserves that duration, and permanently
sets completeness false for this occurrence. It never extends to restart time.
Pre-upgrade work without measurements is likewise incomplete. Complete=true means
complete coverage of these measured intervals, not native turn wall duration or
submission-to-reply latency. Label the terminal value **Observed execution** and
explain that it includes model/tool waits but excludes queue, blocking authorization
and delivery waits. False must be labeled as observed/at least or omitted. An absent
pair means unavailable, not zero. Hosted must not fill either case using createdAt/updatedAt or receipt age.

An active lifecycle snapshot is emitted at admitted attempt start; completion and
interruption carry cumulative snapshots. The terminal snapshot is journaled before
result publication and must be acknowledged first. Lost-ACK replay uses the same
sequence, payload and digest. Receipt-only recovery creates no execution intervals
and does not change the total. A result-only resume of old unmeasured work preserves
its old receipt rather than retroactively adding timing fields. Running snapshots
are observed values, not an authorization to extrapolate through a disconnected
runtime. A later status change without a terminal timing measurement must not turn
an old running snapshot into a final exact duration. Full activities continue through the existing durable normalized sink.

Rollback: disable dispatch and preserve journals/checkpoints before reverting.
Older strict readers cannot consume journals containing the new lifecycle fields;
never clear or edit measurement/receipt history to make an old reader accept it.

### Negotiated Slack channel history

Runtime advertises `capabilities.slackChannelRead:true` and sends
`X-Cyrus-Slack-Channel-Read:1` on authorize/renew. Hosted opts in with optional
admission `slackChannelRead:true`; this flag must remain identical on renewal.
Channel resource is exactly `{provider:"slack",channelId,scope:"channel"}`,
distinct from the existing strict `{provider:"slack",channelId,threadTs}` variant.
Runtime rejects channel admission without negotiation. Old strict runtimes reject
this resource/flag instead of silently running source-free or using a fallback.
No minimum published version is claimed.

The read grant exposes only `read_messages({limit?,cursor?})` and
`read_thread({reference})`. Limit is an integer1..100. Cursor and reference are
server-issued opaque UUIDs; neither accepts Slack channel IDs, timestamps or any
workspace/customer/account/connection/role/grant selectors. All argument objects
are strict. Channel scope never exposes `reply`, even if an erroneous write
permission appears in a grant. Existing thread reads/replies remain unchanged.

Within the existing scoped result envelope, each history `items[].text` is JSON
`{messages:[{reference:<UUID>,text:<bounded string>}]}` with at most100 entries;
`nextCursor` is an opaque UUID or null. Item text remains at most100000 characters.
Resource/connection/account/grant metadata must match the exact admitted channel
binding and is stripped before the model receives the result. `read_thread`
returns the existing bounded text envelope under that same channel binding;
Hosted resolves its opaque reference to the permitted narrower thread.

Runtime retains validated references/cursors only within the admitted MCP
session. Negotiated same-session renewal preserves them; reconnect clears them
and unknown references/cursors return safe history re-read guidance. The server
checks reference/cursor expiry, current grant, exact owner/lease/revision, customer
mapping, connected Slack account, external Slack Connect eligibility and channel
membership on every request, including existing sessions. Local reference
membership never substitutes for server authorization. Expired/revoked access
fails closed; no transparent replay uses a new operation identity.

If channel delegation is granted to a coordinator, arguments are
`{instruction,tracking:"direct"}`. Hosted admits a separate investigator with the
same channel or a narrower thread; runtime cannot choose another resource, attach
an arbitrary ticket or widen the parent's authority. Investigator tools remain
read-only. Existing Linear direct/assigned-ticket delegation stays supported.
Model tool descriptions and native developer instructions state these actual capabilities.
The broker removes Codex-supplied apply_patch/view_image/request_user_input from
the provider-visible catalog; only supervisor-admitted dynamic tools remain. Unknown
tools still fail closed. No native credential, filesystem or unrestricted connector
fallback is available.

### Negotiated current admission for customer session delivery

Runtime sends `X-Cyrus-Session-Delivery-Authority: 1` alongside
`X-Cyrus-Session-Delivery: 1` on authorize/renew. Hosted may return top-level
`sessionDeliveryAuthority: "current-admission-v1"` for coordinator/investigator
customer admissions. Engineering and absent/unknown modes retain the existing
remote preflight. The bounded advertised string is pinned across renewal and
persisted in the private checkpoint: changed values, including absence versus a
newly advertised value on legacy checkpoint recovery, fail closed. Do not silently
upgrade an existing occurrence's delivery mode. Unknown strings confer no capability.

Only the sink's immediate remote `fresh()` is omitted. Runtime still checks abort,
local lease and credential deadlines, workspace/readiness and admitted role. Hosted
must authenticate and recheck the exact tuple/current admission on **every** initial,
append and active replay before journal access, including expiry after lock waits.
Delivery neither renews authority nor authorizes subsequent execution. Periodic
renewal and model/provider/MCP/progress/result gates remain unchanged. Strict receipt
validation, immutable replay, ordered journal delivery and final ACK-before-result
remain mandatory. Completed receipt replay returns only an identical committed item
under current registered owner/exact tuple; it cannot append or reopen execution.

Hosted prerequisite `1e668cf912a5b80827ac326384077a3904bf37e1` adds the exact persisted
admission deadline and advertises this mode after migration. The test-only follow-up
`5a54b0db04a2f0c8ca511c545906cf4b63c8d73e` corrects fixture isolation and has green
database CI. Source runtime/actual SQL-HTTP proof passes against that frozen head;
installed/native evidence is recorded separately in the implementation handoff.
Runtime receiver ACK `260cab4a` accepts Hosted proposals `1b34a52e`/`c90c6347`.
Roll out the additive server gate before optional runtime consumption. Older hosts
without the field retain the preflight; older runtimes must not open new checkpoints.
No published minimum version or live latency acceptance is implied.


### Negotiated combined customer sources

`capabilities.customerSources:true` requires durable session delivery. Authorize and
renew send `X-Cyrus-Customer-Sources:1`; Hosted responds with the optional sibling
`customerSources:true` **only** for the following exact ordered pair:

1. Linear `{provider:"linear",customerId:<UUID>}`, permissions `["read"]` or
   `["read","delegate"]`.
2. Slack `{provider:"slack",channelId,scope:"channel"}`, permissions `["read"]`;
   `["read","write"]` additionally requires the explicit Slack-message contract below.

Only a root coordinator can receive this pair. Stable grant IDs and connection IDs
must differ. Extra, reversed, duplicate, worker, child-session, issue/thread or Linear-write
pairs reject at definition parsing. Two grants without the negotiated true flag,
or that flag on a single grant, reject admission. Existing single-resource contracts
and checkpoint keys are unchanged. The existing Slack/read-set flags remain required.
Old runtimes must remain unavailable rather than silently choosing a source.

One MCP token/session remains bound to the primary Linear grant ID. `list_issues`
and `get_issue` select the Linear binding; `read_messages` and `read_thread` select
Slack. Result metadata must match that selected grant/account/connection/resource.
The model receives no authority selector. Linear issue and Slack thread references
are stored separately, scoped to this session, and retained only across authenticated
same-session renewal. Reconnection clears both; arbitrary/cross-provider references
cannot authorize reads. Server enforcement remains mandatory on every call.

If granted, `delegate_investigation({instruction,tracking,reference})` selects an
issued Linear issue reference. `tracking` is `direct` or `assigned_ticket`. Hosted
admits a distinct child with only that issue and scoped instruction, never pooled
Slack context. Workers cannot receive the combined pair or coordinator writes.
Uncertain delegation retains its operation identity for server receipt reconciliation.

Both complete bindings, the negotiation flag, and any native context envelope are
part of the immutable checkpoint identity. Renewal cannot remove or change either
binding. Removing either source fences the whole old connection/revision; surviving
source work needs a new current definition/occurrence. Terminal result recovery
retains the original pair and native envelope and cannot reopen model/MCP work.
Native memory provenance and fresh association checks for both sources remain Hosted
owned. The original combined-source contract adds reads only. Slack writes require the
separate opt-in below; customer-source negotiation alone never grants sending.


### Explicit Slack sends

Intake notification modes (any-message or installed-bot mention) do not authorize
outbound messages. Hosted owns the per-customer `slack.send: automatic|disabled`
setting, absent/default disabled, current mapping/provider checks and removal of
final-result auto-publication. Runtime never translates completion into a Slack send.
Normal Cyrus continues to deny all Connect/unknown-channel events without fallback;
internal non-Connect behavior is unchanged.

With durable sessions, runtime advertises `slackMessages:true` and sends
`X-Cyrus-Slack-Messages:1` on admission/renewal. Hosted may respond with sibling
`slackMessages:true` only for a scoped customer coordinator. A Slack channel grant
with `write` requires that flag; the flag alone grants nothing. Investigators and
engineering cannot send. Ordered combined Linear+Slack bindings may give only Slack
write permission. Both grants and the flag are pinned in checkpoint identity and
renewal. Old runtimes stay read-only; old thread-bound schemas remain `{text}`.

The channel `reply` tool accepts exactly `{text,reference?}`: 1–10,000 characters and
an optional server-issued session-bound thread UUID. No model authority/resource
selector is accepted. Without a reference Hosted fixes the destination to the
accepted source event thread, otherwise the mapped channel. New sends require
current reference, mapping, permission, lease, revision and provider authority.
The supervisor supplies the stable operation key. Uncertain sends keep that key
and exact payload across recovery; they never re-list/rebind a destination or create
a new key. The server must reconcile an immutable matching committed receipt before
requiring an old session reference to resolve; only a proven receipt permits that
recovery, never a fresh effect. Provider ambiguity remains uncertain, not success.

A successful structured result has exactly one bound `items` entry, `nextCursor:null`
and `receipt:{idempotencyKey:<same supervisor key>,status:"sent"}`. Runtime checks the
key, status and full grant/account/connection/resource binding before model output.
Missing/malformed receipts fail closed and retain pending intent. This wire extension
is coordinated with Hosted; the immutable handoff records receiver ACK and joined
proof. No published minimum version or live provider acceptance is implied.


## Removed standalone prototype (October 1)

The shipping `cyrus customer-runtime` command and `/customer-runtime/v1/*`
server are removed. Their private config loader, global model key adapter, old
scope/operation contract, gateway, checkpoint store and runtime loop have no
registered caller and are no longer exported or packaged. The sandbox uses the current reviewed Node image directly; the old Bun selector
has no remaining caller and is removed. The CLI uses its normal
environment/Sentry bootstrap for every supported command. No standalone package
dependency was exclusive: Fastify, Zod and core utilities still serve active paths.
The edge-worker build cleans its output before compiling so obsolete modules do
not survive a rebuild into an installable package.

Retained code has current callers:

| Component | Current callers / regression |
| --- | --- |
| `automations/DockerSandbox.ts` and its path/snapshot validator | `register.ts` engineering readiness/factory, `AutomationRuntime` engineering execution; engineering automation and Node image tests, active native engineering F1 |
| `utils/readBoundedJson.ts` | automation HTTP gateway, configured Messages model and durable session HTTP transport; streamed-byte bound/cancellation tests and active transport/session tests |
| Registered ledger/checkpoints/authority/receipts | Existing automation execution, resume/retry, fencing and terminal reconciliation; unchanged schemas and storage |

The standalone test suite and executable F1 driver are removed with their subject.
Registered engineering tests already exercise failing-test diagnostics, retained
edits, model-directed repair, immutable publication and result-only recovery.
Host filesystem/credential/network assertions now run against that same current
Node sandbox alongside abort/timeout/output-limit denial. Historical reports and
immutable artifact evidence remain historical; they are not setup instructions or
a compatibility service to reinstall.


## Admitted signal semantics

Hosted owns the structured provenance envelope and provider classification for
ordinary Slack messages, verified installed-bot mentions, Linear events/comments,
scheduled ticks and internal completion signals. JSON serialization or escaped XML
must keep external content separate from trigger metadata. Raw text claiming a
mention, role, customer or permission is never classification or authority.

Runtime labels automation instructions separately from admitted occurrence input
and preserves that complete input verbatim on initial execution and fresh-context
recovery. It does not parse/reclassify/flatten the envelope into an operator message.
Both contained adapters explicitly treat external source content as untrusted
requests/evidence, unable to alter instructions or scope. A verified direct mention
generally warrants a response when relevant and permitted; ordinary notifications
may need no response. Neither grants outbound access: sending remains an explicit
scoped tool operation under current per-customer policy, never automatic final
publication. This prompt distinction supplements real server authorization and is
not an isolation boundary. Existing occurrence/event dedup keys and checkpoint
identities remain outside model text and unchanged. Hosted also owns visible
signal/activity projection; runtime does not fabricate operator activities.

For a ledger-admitted `trigger:tick`, runtime adds a model-only `signal` envelope
with version1/type `schedule.tick`, occurrence ID and scheduledAt provenance and
`internal_trigger` content. Stored/admitted input and identity remain unchanged;
text saying "Scheduled automation tick" cannot select this presentation. Runtime
adds no customer/provider authority metadata. Other signals keep the exact Hosted
envelope; existing historical checkpoints are not rewritten to invent provenance.
