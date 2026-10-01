# Engineering findings delivered to a parent: remaining joined gate

Prepared against Hosted `a65f265730cbb6147588d3cf6e3437d5e13aa4be`
and installed Runtime `397813003cccc9e1f936feff3e96987e1b507229`.
This is a preparation recipe, **not passing evidence**. It extends the existing
owners' fixture boundaries; it introduces no execution or authority contract.

## Production path to exercise

Hosted `automation-callback.ts` selects `engineering_automation_callback` for
assignment results or `customer_automation_callback` for customer/child results.
SQL persists the result and scoped event before the callback awaits
`wakeConnectedCustomerWork`. A failed durable wake prevents the result ACK;
receipt replay must wake delivery again without repeating the result effect.

`connected-event-delivery.ts` starts `customerAgentDispatchWorkflow`.
Its delivery step invokes `deliverCustomerAutomations`,
`deliverEngineeringAutomations`, and the source/reply delivery functions.
`deliverCustomerAutomations` checks current customer revision/pause, then:

- For `automation.child.result`, checks the exact child's `parent_binding_id`
  and a null provider connection.
- For `engineering.result`, checks the current, non-withdrawn assignment link
  matching workspace, customer and thread, plus a null provider connection.
- Builds the input and outbox itself, then forwards definitions, occurrences
  and wake through `registeredAutomationRequest`.

The registered transport resolves the existing workspace target, requires current
configuration, HTTPS and exact ACKs. CYPACK remains the sole occurrence scheduler.
The runtime admits a new parent occurrence under **current** Hosted authority.
It does not resume the completed child as the parent or reuse its MCP session.

Investigation child sessions carry an explicit parent session association.
Engineering assignment sessions intentionally omit private parent session context;
their return route is the Hosted assignment/customer/thread link. Preserve that
distinction: do not add sponsor context to the engineering definition to make the
fixture resemble direct child delegation.

## Smallest complete controlled scenario

1. Use one disposable customer, a coordinator binding and one reviewed assignment
   linked to its work thread. Reuse the existing engineering SQL fixture's synthetic
   source, failed-test/repair sequence and fixed GitHub transport. No second sponsor,
   production release action or shared implementation management.
2. Run `deliverEngineeringAutomations` against real disposable SQL and the existing
   installed Runtime HTTP service. Keep the production registered transport; map
   only its fixed fixture HTTPS destination to loopback in test transport. Do not
   insert a runtime occurrence or mark delivery complete directly.
3. Let contained execution repair and test the source, publish through actual MCP
   and SQL using controlled GitHub transport, and reconcile a deliberately lost
   publication ACK. Require one PR and unchanged publication operation identity.
4. Route the actual result through the production callback. Intercept only the
   Workflow platform transport to record its durable wake intent, then execute
   the production customer dispatcher against SQL. Do not manually construct the
   parent outbox or copy the result into its prompt.
5. Execute the resulting coordinator occurrence with the existing contained native
   oracle. Assert its current admitted input contains the returned PR/findings and
   thread linkage, excludes the foreign customer's sentinel, and produces a final
   response referencing the returned evidence. Require ordered activity ACKs before
   the final result, the same durable parent session, and a distinct occurrence.

Publication and final findings may produce **different legitimate result events**.
Assert one immutable occurrence per `(binding, revision, event)`; do not collapse
all events from one assignment into a single occurrence or count replay as new work.

## Failure and isolation assertions

- Lose one occurrence ACK after acceptance, repeat dispatch after its bounded retry
  becomes due, and require the same outbox/input/occurrence identity. No second
  model execution for that event. Check SQL delivery state: the dispatcher catches
  errors into `last_error`, so a resolved function promise alone is insufficient.
- Lose the durable result-wake ACK and prove terminal receipt recovery wakes the
  dispatcher without reopening engineering execution or publication.
- Pause the customer or withdraw the assignment link before delivery; no parent
  occurrence is admitted. Withdrawal between dispatch and admission is denied by
  current Hosted authority. Retain historical immutable receipts.
- Another customer/workspace and an unrelated root cannot receive a child's
  result. Engineering results require the exact current sponsor/thread link.
- Both direct and optional ticket-backed investigation children use the same
  production dispatcher/successor assertion in their existing scenarios. Direct
  children create no Linear session; ticket associations remain server-admitted.
- Keep combined-parent/narrow-child resource checks and private checkpoint/session
  isolation. A parent result never grants the child coordinator writes.

## Reuse and ownership

Runtime already supplies `oracle-native.mjs`, installed HTTP/SQLite execution,
contained repair and checkpoint/session replay. Hosted owns its production SQL
adapter, registered-target/config fixture and Workflow transport seam. Agree one
shared fixture with that owner before adding a competing dispatcher emulator.
The existing `automation-dispatch.test.mjs` uses in-memory tables; it is useful
unit coverage but cannot establish this SQL/native gate.

The optional installed test in `engineering-automation.integration.test.mjs`
currently adds a second sponsor and expects shared fanout. That positive setup
must be narrowed to one customer for this capped gate; shared historical receipt
tests remain compatibility evidence only. Existing four-mode native proof manually
delivers prepared outbox rows and stops after child completion. Neither substitutes
for the production dispatcher plus parent successor described here.

This controlled join would still exclude real Workflow infrastructure, signed
provider ingress, live provider assignment and rendered UI reload. Label those
separately; the coordinator owns live acceptance and any installation.

## Prepared runtime driver (joined validation pending)

`apps/f1/native-context-join/parent-successor-drive.mjs` reuses the engineering
drive and `nativeOracle` against an exact installed package source SHA. Syntax
and lint checks pass; it is **not yet executable proof of this gate** without the
Hosted counterpart fixture. Do not substitute its expected flags for SQL assertions.

Private fixture fields are the existing `origin`, `supervisor`, `definition`,
`image`, `dockerPath`, `dockerHost`, plus `parentDefinition`, `runtimeSha` and a
synthetic uppercase `findingsMarker`. Its only fixture control request is
authenticated `POST /fixture/dispatch` with `{origin: <runtime loopback URL>}`.
The fixture must validate that origin is exactly a local HTTP root, without
credentials/query/fragment, and bind it for that disposable registration only.
This is not an endpoint to add to the production runtime or Hosted service.

The reply has `done`, `parentEventCount`, `productionDispatcher`,
`occurrenceAckLost`, `duplicateDispatchDeduplicated`, `foreignCustomerDenied`,
`withdrawnSponsorDenied`, `pausedCustomerDenied`, and `publications`.
Each assertion flag must be derived from the real SQL/transport checks above.
`done` is true only after those checks and all intended events are dispatched.
The driver independently observes terminal registered status, exact model counts,
failed/passing command exits, parent input evidence and no repeated parent model
execution. It loses one engineering result ACK, requiring normal receipt recovery.
It never calls definition/occurrence submission directly.

Both runtime and engineering execution use the existing reviewed image. Invocation
is `node parent-successor-drive.mjs PRIVATE_FIXTURE_DIRECTORY INSTALLED_AUTOMATIONS_DIRECTORY`
with the existing `CYRUS_F1_CODEX_IMAGE` and authorized Docker environment. The
Hosted test harness owns launch, isolated SQL setup, production dispatcher wiring,
final database assertions and cleanup. Coordination request `eb165177` supplies
this interface; actual owner acknowledgment and a passing joined run remain open.
