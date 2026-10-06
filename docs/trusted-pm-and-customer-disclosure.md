# Registered PM and customer disclosure contract

CYPACK-1546 / CYHOST-1321, subsequent phase after Runtime `03e2d63a` and Hosted
`8ad30aa9`. This supersedes customer-operated direct engineering and automatic
engineering-result fanout. It does not remove generic non-customer engineering,
private historical audit, or immutable terminal receipt recovery.

## Ownership

Hosted verifies original email intake against the specific customer, projects
all tools/events/context/history, and owns private affected-customer relations,
PM admission/outbox, PM UI and private session/result persistence. Unknown or
non-email provenance exposes only a ticket's human identifier and status.
Runtime accepts authenticated policy, validates tool projections, pins the
policy epoch through checkpoints/renewal, and keeps customer and PM execution
separate. Customer text cannot select PM authority, repositories or customers.

One SQLite occurrence/lease ledger remains authoritative in the registered
runtime. Hosted uses its existing binding/outbox and admitted lifecycle APIs.
There is no separate customer-runtime service, PM scheduler or legacy fallback.

## Customer connection

Capability `customerLinearDisclosure: "email-origin-v1"` and authorization
header `X-Cyrus-Linear-Disclosure: email-origin-v1` negotiate admission sibling:

```json
{"customerPolicy":{"version":1,"epoch":"UUID","linearDisclosure":"email-origin-v1"}}
```

`list_issues()` returns a scoped item whose JSON text is strictly:
`{issues:[{reference:UUID,identifier:string,status:string}]}`. No association
counts, held counts, titles or other metadata are allowed. `get_issue({reference})`
returns exactly one of:

```json
{"disclosure":"identifier_status","issue":{"identifier":"TEAM-1","status":"Todo"}}
{"disclosure":"verified_customer_email","issue":{"identifier":"TEAM-2","status":"Todo","title":"Subject","description":null}}
```

The verified branch describes existing supported full-ticket fields, not new
comment/attachment tools. Provider provenance checks are Hosted-owned; the
runtime validates this authenticated projection, not email strings in prompts.

A changed or missing policy epoch cannot resume any old nonterminal checkpoint,
model transcript or pending write. Hosted creates a new revision/occurrence with
freshly filtered input/context. Existing terminal receipts remain byte-exact,
private and model-free. No historical pending action is automatically reissued.

Capability/admission `oneWayEngineering:true`, header
`X-Cyrus-One-Way-Engineering: 1`, permits coordinator-only
`submit_engineering_request({request:string[1..10000],reference?:UUID})`.
Source-free requests are supported. The optional reference is an opaque current
Linear session reference; arbitrary provider/customer/PM/repository IDs are not
arguments. Extra fields are rejected. The receipt is strictly
`{submissionId:UUID,status:"accepted"}`. No PM result, session, transcript or
other customer's association is returned. Customer direct delegation is absent
when this policy is admitted. Workers cannot submit or acquire PM capabilities.

An uncertain submission retains its exact arguments and supervisor operation
key. On reconnect Hosted checks current authority, then immutable receipt
identity/payload, then current-session reference validity for a **new** effect.
A receipt can reconcile without turning an old reference into new authority.
Runtime does not rewrite the reference or invent a second operation identity.
The accepted submission receipt is retained as a bounded action outcome during
fresh-context recovery, preventing model-driven resubmission.

## Trusted PM registration and admission

Final identity correction acknowledged in Hosted reply `ff8fd4a6`:

- Definition `id` and lifecycle `automationId` are the PM UUID.
- `execution: "trusted-pm-v1"`; `namespace` and `scopeRef` are `pm:{pmId}`.
- Role `coordinator`, grants `[]`, schedule `null`, no definition session/parent.
- Admission sibling:
  `{trustedPm:{version:1,pmId:UUID,submissionId:UUID,linearWorkspaceId:string,repositoryIds:string[]}}`.
- Normal occurrence/attempt/fence/lease/input tuple and `sessionDelivery` remain.
- Session ID `pm:{pmId}:{occurrenceId}`, same scope, no parent, issue association
  or external Linear session. Native Codex resume ID is separate.
- Customer MCP credential, customerPolicy, nativeContext, customerSources,
  engineering and slackMessages envelopes are absent. PM uses ordinary
  registered runner configuration, not the customer MCP connection.
- Capability `trustedPm:true` and header `X-Cyrus-Trusted-Pm: 1` are available
  only with the configured normal adapter and durable session transport.

Initial adapter support is Codex. Other harnesses are not advertised. This
capability means a configured adapter exists; it is not proof that a live model
login/provider call has succeeded. Existing same-user normal Codex configuration
and login are prerequisites; no credentials are copied from another account.
Each repository ID must resolve to an active repository in the admitted,
currently connected Linear workspace. Paths and connector credentials come from
runtime configuration, never the submitted request. Admission/renewal and the
normal concurrency-slot start boundary recheck current authority/configuration.

The adapter reuses RunnerConfigBuilder, CodexRunner, AgentSessionManager and the
durable Cyrus sink. It owns a private PM workspace/memory and native resume
checkpoint, and uses a dedicated normal app-server process so fenced cleanup can
confirm shutdown. Ordinary unscoped runners retain their pooled processes.
Supervisor pairing/tunnel keys are suppressed from the child environment.
A cleanup failure retains the Hosted owner lease; it is not acknowledged as an
interruption. PM execution cannot import contained transcripts/customer tools or
register a parent callback. Only Hosted's private PM result path receives output.

## Validation and remaining gate

`apps/f1/trusted-pm/drive.mjs` runs registered HTTP/SQLite through the actual
normal CodexRunner, subprocess JSON-RPC, formatter and durable sink. Its child
app-server, model/provider and Hosted responses are controlled. It proves one
private commit through lost ACK, configured-repository withdrawal followed by
receipt-only recovery, and no customer fanout. It does not prove real native
Codex/provider behavior or actual Hosted SQL.

Focused SDK tests exercise restricted/full projections, forged metadata,
current-session references, lost submission ACK and revocation. Runtime tests
cover policy change, fresh-context receipt recovery, bad PM identity/authority,
normal concurrency fencing and confirmed process termination. Actual paired
Hosted SQL/MCP/native validation and independent installation remain required
before feature enablement. No published minimum cyrus-ai version exists for this
unreleased contract. No live runtime change, customer prompt or provider write is
authorized by this document.
