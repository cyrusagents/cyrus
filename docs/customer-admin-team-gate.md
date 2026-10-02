# Existing team eligibility and the registered runtime

CYHOST owns the customer-feature gate using the current owning team's existing
`teams.is_admin_team` boolean (`get_team_is_admin_team` / `isAdminTeam`). A member's
admin role does not turn on customer execution. Runtime has no team allowlist,
customer database connection, cached eligibility flag, or second cancellation
engine. Ordinary generic automations and internal Cyrus stay independent.

## Mandatory boundaries

- Definitions persist desired configuration, not execution authority. Registered
  instruction/event requests queue durable occurrences; local schedule ticks use
  the same ledger. `AutomationRuntime.drain` calls Hosted authorize/admit with the
  exact registered workspace, definition/revision, occurrence, attempt and fence
  before opening a model, sandbox or scoped tool transport.
- Gate-OFF can leave a stale definition or queued occurrence in SQLite. Admission
  denial records the existing safe failure/retry state; it never falls back to an
  unrestricted runner. Runtime does not erase queues or reset retries on a flag
  change. Already paused schedules remain paused.
- Native execution refreshes current authority using MCP tools/list while its
  admitted lease is sufficiently long, or authorize/renew near lease expiry.
  Every scoped tool invocation and provider boundary retains current checks.
  Hosted must enforce eligibility there, not only on the first admission.
- Negotiated session delivery/progress/result paths can omit a redundant Runtime
  preflight only because the Hosted receiver performs the current authority check
  at that action. Local abort and expiry checks remain. The gate does not change
  either protocol or grant/resource identity.
- A trusted PM opens the ordinary registered workspace runner in a separate
  private session. Its `beforeStart` callback rechecks Hosted authority **after**
  acquiring a shared runner-concurrency slot. Regular current-authority renewal
  stops revoked work. Normal PM provider tools are not customer MCP credentials:
  a team-flag change cannot synchronously retract an already in-flight provider
  operation. No new instantaneous cancellation guarantee is claimed.

## Recovery and history

Completed immutable result receipts may reconcile while eligibility is OFF only
if Hosted returns the existing result-only reconciliation authority and validates
its exact original tuple/payload. Runtime requires an existing terminal checkpoint
with the pending original result and does not reopen model/tools/progress. Normal
pending operations and unfinished checkpoints require current execution authority;
turning the gate off is not permission to finish an uncertain write or mint a new
operation identity. History and checkpoints remain intact.

Slack Connect remains exclusively Hosted customer ingress. The normal Runtime
Connect/unknown-channel guard has no fallback and is independent of whether the
customer gate permits forwarding. Internal non-Connect behavior is preserved.

## Verification scope

`CYRUS_NATIVE_JOIN_ROLLOUT_GATE=1` in the existing native-context joined driver
uses only disposable SQL teams. It exercises queued instruction and event
admission, a stale registered scheduled tick, withdrawal after successful
admission but before the first MCP current check, and terminal ACK recovery after
withdrawal. The installed Runtime uses real registered HTTP, SQLite/checkpoints,
MCP SDK and native Docker; Hosted handlers and migrations are frozen to an exact
commit. Model/provider transport and source outbox construction remain fixtures;
this does not claim live signed ingress or a real team's activation.

Existing normal PM F1 covers queued-start authority, private activities, revoked
execution and receipt recovery. The separate Hosted production PM adapter/SQL
fixture must also prove the team gate. Results and exact candidate hashes belong
in the corresponding verification report; this contract alone is not evidence
that an untested Hosted implementation is safe.
