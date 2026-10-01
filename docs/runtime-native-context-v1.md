# Registered native context v1

CYPACK-1546 / CYHOST-1321 reuse the registered automation ledger, current admitted
execution and `/mcp`. This is a generic native-context capability: no customer table,
provider connector, second scheduler or unrestricted runner is introduced in CYPACK.
Hosted owns scope interpretation, provenance visibility, action policy, approvals,
trusted outcomes, customer confirmation and the durable data store.

Base schema was proposed in Runtime comment `6af1cf55` and accepted by Hosted
`10b988a9`. Runtime reply `b50e1c12` accepts the work extension and specifies its
optional bounded read fields. The `outcomes` name/shape awaits Hosted confirmation.
Implementation and controlled tests do not establish deployed or joined acceptance.

## Negotiation and binding

A runtime with durable session delivery advertises `capabilities.nativeContext:true`
and sends `X-Cyrus-Native-Context:1` on authorize. Without explicit returned admission,
none of these tools or context retrieval is enabled. Old runtime behavior remains
unchanged; Hosted must not send this envelope to an unsupported runtime.

Admission has this optional sibling of `authority` and `mcp`:

```ts
nativeContext: {
  contractVersion: 1;
  bindingId: string;
  scopeRef: string;
  permissions: ('read' | 'remember' | 'apply_approved' | 'work')[];
}
```

Identifiers are 1..200 ASCII letters/digits/`_.:-`. Permissions are unique, at most
four and include `read`. Only a root coordinator with negotiated session delivery
may receive this envelope. Scope must equal the admitted definition's opaque scope.
Workers/engineering never gain native context by copying a provider connection.
Source-free MCP uses `mcp.grantId === nativeContext.bindingId`. With a provider grant,
`mcp.grantId` remains its binding ID and native context is separately bound. Both are
included in the private checkpoint scope; changed bindings/permissions fail recovery.
Credentials stay outside model context, native files and checkpoints.

## Strict tool arguments and structured results

| Tool | Arguments | Permission |
| --- | --- | --- |
| `read_context` | `{cursor?:UUID}` | read |
| `remember_context` | `{kind:'confirmed'|'source'|'conclusion'|'hypothesis',body:string(1..4000),evidence_reference?:UUID}` | remember |
| `apply_approved_action` | `{reference:UUID}` | apply_approved |
| `track_work` create | `{objective:string(1..500)}` | work |
| `track_work` update | `{reference:UUID,objective?:string(1..500),status?:'active'|'waiting'|'verified'|'confirmed'|'closed',outcome_reference?:UUID}` with at least one changed field | work |

Undeclared fields reject. No workspace/customer/run/grant/account/issue/thread IDs
are model arguments. References and cursors are issued by Hosted in the current
session; renewal preserves them only through the existing authenticated same-session
protocol. A disconnected read cursor prompts a fresh first page. New writes require
current references; uncertain writes preserve their exact previous arguments and
operation identity for server receipt reconciliation before any new effect.

`read_context` returns strict MCP `structuredContent`:

```ts
{
  bindingId: string;
  scopeRef: string;
  snapshotRevision: string;
  entries: {kind, body: string /* <=4000 */, provenance: string /* <=1000 */,
            evidence_reference?: UUID}[]; // <=25
  nextCursor: UUID | null;
  approvedActions: {reference: UUID, description: string /* <=1000 */}[]; // <=25
  inputEvidence?: {reference: UUID, description: string /* <=1000 */}[]; // <=25
  work?: {reference: UUID, objective: string /* 1..500 */, status: WorkStatus}[]; // <=25
  outcomes?: {reference: UUID, description: string /* <=1000 */}[]; // <=25
}
```

The complete structured page is limited to 150,000 UTF-8 bytes, including optional
fields. `WorkStatus` is the same update enum. Pagination must cover the authorized
set, including facts beyond the UI projection limit. Hosted filters withdrawn source
facts before output, derives input evidence and issues only eligible trusted outcomes.
The runtime validates binding/scope and bounds, then removes those authority fields
before supplying the model with entries and continuation metadata.

Each write returns strict `{bindingId,scopeRef,status:'applied'|'pending'|'denied',
receiptId}`. The model receives only status. Pending is a proposal, not a saved fact
or changed work item. Only Hosted can validate terminal work transitions against
matching proof; `confirmed` additionally requires customer confirmation. Approval
must bind the exact action/payload/current policy. The operator approves through
Hosted, which durably admits a current successor occurrence and provides its action
reference; the expired proposing run is not revived.

## Fresh context and durable continuation

Before model execution for every admitted instruction/event/tick or recovered
attempt, the runtime fetches a fresh bounded page under current authority. It emits
normalized read tool activities using the existing durable sink. On recovery it
reconciles any saved pending operation (including native tool intent saved just
before the runtime pending checkpoint) with its original key before opening a model.
It then discards the old native transcript and old source/context outputs, builds a
new prompt from the immutable admitted instruction/input plus current context, and
records a new native harness identity under the same Cyrus session. Bounded status
hints retain applied/pending/denied distinctions without retaining old fact bodies.
Further pagination is available as a tool; truncation is explicit.

Each write key binds checkpoint scope, operation name and exact payload, independent
of retry attempt or native call ID. Hosted must atomically bind that key to payload
and receipt, reject changed payloads and deny new effects under revoked authority.
Terminal-result recovery replays ordered session/result receipts only: it never fetches
new context, reopens a model or applies another action. Periodic renewal, current
MCP checks, abort/deadline handling and flush-before-result barriers are unchanged.

## Reproducible controlled validation

```sh
pnpm --filter cyrus-edge-worker exec vitest run test/native-context.test.ts test/native-context-runtime.test.ts
pnpm --filter cyrus-edge-worker build
CYRUS_TEST_DOCKER_HOST=unix:///var/run/docker.sock \
CYRUS_F1_CODEX_IMAGE=sha256:35ffa8e695666695f047cf527138b9b27f2e1c29d44673f9eb705a0e4010be4f \
node --input-type=module -e 'const {runAutomationDrive}=await import("./apps/f1/automation-drive.mjs"); console.log(JSON.stringify(await runAutomationDrive({nativeContextOnly:true,sessionDeliveryAuthority:true}),null,2))'
```

Use only an authorized isolated Docker socket with the preloaded immutable image;
no image pull, host mount or container network is used. This drive runs production
registered HTTP handlers, SQLite, checkpoint store, MCP SDK, native Codex/Docker and
ordered session delivery, with controlled authority/provider/model responses.
It checks memory lost-ACK/restart, fresh transcript/context, later-occurrence recall,
work create/update and pending approval applied by a distinct successor. Unit/SDK
regressions cover strict arguments, 125-fact pagination, scope/role isolation,
reference rotation, proof denials, policy/revocation, native intent crash and terminal
receipt recovery. Actual Hosted SQL/HTTP/installed native joining and UI persistence
remain separate acceptance gates. No published minimum version is claimed.
