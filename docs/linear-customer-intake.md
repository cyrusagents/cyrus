# Linear customer association intake — implementation proposal

Owner split: CYHOST-1321 interprets providers, maps customers, admits resources
and owns its binding/outbox. CYPACK-1546 runs opaque authorized occurrences in
the existing generic SQLite ledger. This proposal adds no provider matching,
customer tables, subscription management or second scheduler to CYPACK.
It preserves the [automation contract](runtime-automations-v1.md), scoped MCP,
and the [session delivery dependency](session-activity-persistence.md).

## Inspected baseline (2026-09-29)

Runtime uses `@linear/sdk`64.0.0; the installed hosted SDK is59.1.0. Both contain
`Customer` and `CustomerNeed` discriminated webhook types. Their generated
CustomerNeed payloads contain `id`, `createdAt`, `updatedAt`, optional
`archivedAt`, `customerId`, `issueId`, `originalIssueId`, `commentId`, `attachmentId`,
`projectId`, and optional nested customer/issue data. Both customer and issue
associations can be absent. The hosted SDK exposes `customerNeed`, paginated
`customerNeeds`, and `Issue.needs(...)`; do not assume the connector's normalized
`customerNeeds[]` output is the GraphQL field name on Issue.

Hosted `app/api/linear/webhook/route.ts` verifies the raw webhook using
`LinearWebhookClient.parseData` before calling `ingestConnectedEvent`. It passes
the selected organization and marks multiple candidate operating workspaces as
ambiguous. `connected-event-contract.ts` currently accepts only Issue
create/update/remove for Linear, hashes the raw body for identity, and emits
ID/action metadata. `mcp-provider.ts` checks an admitted issue/team and returns
title/description/state; it does not yet revalidate CustomerNeed associations or
read comments. Runtime's legacy Linear message translator does not implement
customer association intake, and is not the place to add it.

The [provider model documentation](https://linear.app/developers/managing-customers)
describes CustomerNeed as a customer request with an optional customer association.
The [webhook documentation](https://linear.app/developers/webhooks) lists customer
and customer-request events; the [manifest schema documentation](https://linear.app/developers/oauth-app-manifests)
names Customer and CustomerNeed subscriptions. [Email Asks](https://linear.app/docs/linear-asks-email)
can link customers by email domain with Customer Requests enabled. These establish
API support, not the preview app's subscriptions or access. No preview subscription
inspection or live association test is claimed by this source review.

## Minimal hosted implementation

1. **Follow policy and identity.** Operator selects Linear Customers to follow,
   or explicitly enables auto-intake. The durable unique identity is operating
   workspace + connected Linear organization + Customer.id. Connection identity
   selects credentials and is separately verified; reconnection must not duplicate
   the customer. Internal first-contact creation is an idempotent policy action,
   not permission for provider writes, billing changes or outgoing messages.
   Name, email, domain, external IDs and attachment text cannot mint authority.

2. **Verified metadata receipt.** After the existing signature/account checks,
   admit Customer and CustomerNeed create/update/remove alongside Issue events.
   Preserve a durable connection/organization-scoped delivery receipt. Use
   Linear-Delivery when present with an immutable payload digest; a conflicting
   duplicate is rejected. Keep semantic reconciliation idempotent too, since
   different deliveries may describe the same state. Retain only event type,
   action, IDs, provider timestamps, and association IDs needed for reconciliation;
   do not route webhook bodies/comments/attachments into customer contexts.

3. **Reconcile authoritative associations.** Initial enable/reconnect and events
   run the same bounded, paginated metadata reconciler. For CustomerNeed changes,
   consider current issueId, updatedFrom.issueId, originalIssueId and the locally
   recorded prior issue; reconcile both sides of a move. Current provider state
   is authoritative; timestamps and delayed create/update events cannot resurrect
   a removed grant. Project-only, null, inaccessible or incomplete pagination
   results remain held, without issue content access. Customer archive/removal,
   lost account access or policy disablement invalidates dependent resources.

4. **Exclusive resource admission.** Read all current need/customer IDs for the
   issue, including customers that are not followed. Exactly one distinct eligible
   customer is necessary; multiple needs for that same customer are not multiple
   customers. Missing customer on a relevant need, multiple distinct customers,
   ambiguous organization mapping or incomplete visibility holds the issue.
   Previously shared/reassigned issues stay held for explicit safe-content review;
   removing one association does not erase the other customer's historical text.
   MVP has no automatic shared-issue body/comment exposure and no new shared-resource
   exception. Mapping an organization/customer once removes repetitive issue mapping
   while preserving this resource safety gate.

5. **Invalidate before redispatch.** Association changes atomically invalidate
   old issue grants and queued admissions, increment the existing authority revision,
   and record the held/current mapping. Existing MCP sessions recheck that revision
   and current provider association on every call, including reads. Before returning
   issue content, validate the fetched resource's association set and the current
   local grant again; errors or disagreement discard the content. No model-selected
   IDs or new tool arguments. Keep uncertain write receipts immutable; revocation
   cannot trigger a replay with a fresh operation identity.

6. **Use the existing outbox.** Only an admitted resource yields a binding and
   metadata-only wakeup through the existing hosted outbox to the generic runtime
   occurrence endpoint. Stable event identity, definition revision and opaque scope
   provide dedup/fencing; CYPACK learns no matching rules. Updates received during
   execution remain queued for the next safe turn. Bounded initial reconciliation
   uses the same intake receipt/outbox path, not a parallel automation engine.

## Required proof and subscription inventory

The coordinator verifies the actual preview organization, app authorization,
Customer/CustomerNeed read access, enabled webhook resource types, endpoint and
isolated test-issue permissions. Webhook inspection may require admin rights;
record unavailable evidence as unknown, not subscribed, and do not broaden OAuth
permissions silently. Only the feature alias is used for browser/auth/live QA.

Controlled tests must cover duplicate and out-of-order events; initial pagination
and interrupted reconciliation; same-customer multiple needs; null/project-only
needs; customer/issue moves, archive/removal, revocation and reconnect; two customers
plus a second workspace; shared historical content; stale open MCP sessions and
no provider content returned after invalidation. Test enabled/disabled intake policy
and one internal customer under concurrent first contact, with no implicit writes.
Instruction/tick/event tests must still dispatch through the registered entrypoint.

Live Linear verification uses only a coordinator-approved isolated issue after
configuration and contained model readiness pass. Real customer examples remain
read-only and are never mutation fixtures. Comment notifications need explicit
Comment subscription/handling and content policy; Issue/CustomerNeed support alone
does not establish email-reply coverage. Slack remains controlled/synthetic until
a live connected test workspace/channel and safe mapping are available; it does
not block Linear. This document is a proposal, not implementation or live acceptance.
