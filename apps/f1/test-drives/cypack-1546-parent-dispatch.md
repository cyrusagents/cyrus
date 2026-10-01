# CYPACK-1546 — production dispatch and a parent successor

## Executable-mode bridge regression (2026-10-01)

Frozen Hosted `19702b7de6f9b778cdd37e4fd273d109d0025a1c`, installed Runtime
`d66ed0a86d0d925fe88469a142da93f640aee416`: **1test/24assertions PASS49.07s**.
The controlled GitHub transport now serves the exact immutable base tree and
asserts that editing an admitted100755 file preserves its executable mode. This
exercises Hosted9058's correction; Runtime production code and artifact are unchanged.

The original failed-test/repair1→0, one publication, lost ACK recovery, current
scope denials and two parent successors remain. Three occurrences complete,
four native opens/closes, six model exchanges,29 activity deliveries, four result
transmissions. Evidence and source hashes:
`CYPACK-1546/attachments/engineering-mode-parent-1970-d66/inputs.json` and
`parent-summary.json`. The fixture file SHA256 is
`b4b17d515c37a785261a122248d2ecd8026518b695795d7237d35c59e0af3339`.
Reproduce with the command below, substituting these exact Hosted/Runtime SHAs.
The installed d66 bundle/image remain unchanged. Registration/Workflow transport
and model/GitHub are controlled; this does not close the production Workflow
pending-outbox retry or live responsiveness gates.

## Original exact-head evidence

Installed Runtime: `397813003cccc9e1f936feff3e96987e1b507229`.
Original frozen Hosted: `a65f265730cbb6147588d3cf6e3437d5e13aa4be` (failed).
Corrected published Hosted: `f16c70e66c166b2afef357e7b81d68d6f8760f82`.
Status: **PASS — production dispatch and source-free parent successor**.
No live environment changes; original failure evidence retained below.

## Corrected exact-head result

Unchanged driver/fixture from `980641252b4bc7ee55a50ac865e0d1bbc4aa1680`
(executed at test-only head `e24ec55b10605b837ba7463bdcbdec54fdf7e561`).
The only product change is Hosted migration admitting the exact current
assignment/sponsor/thread engineering result and checking sponsorship on active
operations. No switch to a provider-bound parent or weakened assertion.

One Bun test/21 assertions passed in49.24s; native driver46.434s. Three completed
occurrences: engineering and two legitimate result-event parent successors.
Four native opens/closes and six model exchanges; failed test exit1, repair,
passing exit0; one publication/reconciliation, four result transmissions,
29 durable activity deliveries and four callback wake receipts. Production
dispatch was polled167 times at250ms while preserving the real30s retry deadline;
that count is not168 model executions. Lost publication/result/occurrence ACKs
recover without duplicate parent work. Pause/withdrawn-sponsor/foreign-customer
checks pass. Parent input contains actual dispatched findings/PR, not a prepared
outbox or copied prompt.

[Published-head summary](evidence/cypack-1546-parent-f16c-summary.json).
The initial pre-push commitffac422c also passed; its [summary](evidence/cypack-1546-parent-ffac-summary.json)
is preserved. Hosted amended only an unrelated test expectation before publishing;
the gate was rerun on the exact remote SHA without changing driver assertions.
Executed source hashes and full controlled log are in
`attachments/parent-dispatch-f16c70e6/` for CYPACK-1546. Installed source3978 and its
17-package bundle/image are unchanged; this increment needs no new installation.

This test invokes unchanged Hosted `deliverEngineeringAutomations`,
`deliverCustomerAutomations` and `automationCallback` against real PostgreSQL.
The driver exposes installed registered HTTP, SQLite, private checkpoints,
native Codex and an isolated engineering Docker sandbox. It never submits
work directly: production dispatch creates and delivers it; real publication
and completion SQL create the result events. Model/GitHub responses are controlled.

One customer owns the reviewed assignment. A separate customer is a negative
isolation fixture, not another sponsor. Engineering runs a failed test, repairs
and reruns it, requests publication and returns findings. Publication and result
ACKs are deliberately lost. Parent dispatch preserves per-event/input/occurrence
identity. Pause and withdrawn-link probes require no parent outbox before current
authority is restored inside this disposable fixture.

## Preserved original failure and diagnosis

Engineering reaches its terminal result. The production customer dispatcher
creates the engineering-result outbox and sends it to the installed runtime.
Actual `customer_sources_admit` rejects the source-free parent with
`Conversation event outside scope`. No parent model runs.

The bounded failed-run summary records one completed engineering admission,
one publication and one publication reconciliation, two persisted parent outbox
rows, zero parent admissions, two callback wake receipts and 15 activity deliveries.
Pause, withdrawn-sponsor and foreign-customer dispatcher checks passed. A lost
occurrence ACK was injected, but duplicate dispatch completion is **not proved**:
the parent blocks before the retained 30-second retry finishes. The failed test
took 34.14 seconds. Its source snapshots and counts are retained in
`context-rejection-39781300/parent-a65f-reproducer/`.

Published migration `20261001050000_customer_automatic_actions.sql` restricts
`customer_conversation_admit` to `operator.message`, whereas the dispatcher routes
`engineering.result` to conversation bindings. The engineering sponsorship wrapper
does not make that conversation predicate accept the valid result. Handoff
`aa94763e` requests exact current assignment/customer/thread/null-connection
validation, renewal/withdrawal denial and unchanged terminal receipt recovery.
Do not admit arbitrary internal topics or replace this source-free parent merely
to pass the fixture.

Earlier runs found fixture transport issues: Bun serializes JSON objects itself,
so pre-stringifying sent a JSON string; raw bigint columns also differed from
PostgREST's numeric JSON revisions. The adapter now passes objects directly and
returns rows through PostgreSQL `to_jsonb`. No product changes. Failed logs retained.

## Reproduce

```sh
CYRUS_TEST_DOCKER_PATH=/usr/local/bin/docker \
CYRUS_TEST_DOCKER_HOST=unix:///approved/same-user/docker.sock \
CYRUS_F1_CODEX_IMAGE=sha256:35ffa8e695666695f047cf527138b9b27f2e1c29d44673f9eb705a0e4010be4f \
node apps/f1/native-context-join/run-parent-successor.mjs \
  /absolute/hosted-checkout FULL_HOSTED_SHA \
  /absolute/isolated-installed-prefix \
  397813003cccc9e1f936feff3e96987e1b507229 /absolute/new-evidence
```

The launcher freezes Hosted and fixture/driver sources and records hashes.
The existing Hosted harness creates and drops disposable local PostgreSQL.
`hosted-partial.json` records bounded counts even on failure;
`parent-summary.json` requires all assertions to pass. A resolved dispatcher
promise is insufficient: it catches errors into delivery state. The real
30-second lost-outbox-ACK retry deadline is retained.

Registered target/config resolution and cloud Workflow transport are controlled.
Signed ingress, live provider assignment, UI reload and responsiveness are separate
gates. Current live3978/a65 catalog latency remains unaccepted despite this
fixture's functional pass.

The reviewed assignment and coordinator definition are fixture setup. This does
not yet prove a parent model creating the engineering handoff or resuming a prior
parent harness session; it isolates return dispatch and a newly admitted successor.
