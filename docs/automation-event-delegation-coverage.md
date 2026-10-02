# Event and delegation fixture inventory — 2026-10-01

Updated with installed Runtimee26a77f8 against frozen Hosteda3359a3b: four native
SQL modes passed, 87 tests / 1,029 assertions. See the [joined report](../apps/f1/test-drives/cypack-1546-native-events-children.md). This is controlled proof, not live acceptance. Canonical verifier checklist gates:
SETTINGS-02 (Linear), SETTINGS-03 (Slack), ENGINEERING-01 (investigation children),
and the session timeline/tenant isolation gates. Existing evidence stays historical.

## Reusable boundaries

| Fixture | Real boundary | Controlled boundary / remaining gap |
| --- | --- | --- |
| CYPACK `apps/f1/automation-drive.mjs`, full default drive | Registered HTTP, SQLite claims/ticks/events, private checkpoints/journal, SDK transport; actual contained Codex when image selected | Gateway authority/provider/model transport are fixtures; not Hosted SQL/signatures/outbox |
| Hosted `automation.integration.test.mjs` + `tooling/customer-automation-runtime-drive.mjs` | Actual Hosted handler/RPC/SQL, installed Runtime HTTP/ledger/MCP, current admission, session timeline and receipts | Runtime `model.next` stub, no native container; manually delivers prepared outbox; fixture provider identities |
| Hosted `connected-event.integration.test.mjs` | Normalization + SQL routing/dedup/queued retention, ambiguous/foreign account and customer holds | Direct normalized ingestion; no signed route/native execution |
| Hosted `connected-route-failure.test.mjs` | Actual Linear route/signature check and retryable wake failure | Mock intake/DB/wake; not full successful route→SQL→runtime chain |
| Hosted `linear-comment-ingress.test.mjs`, `linear-intake-handler.test.mjs`, `slack-channel-ingress.test.mjs` | Production verified-ingress hooks, sequencing, preparation/wake/error behavior | Mock stores/provider/workflow; no actual native consumer |
| Hosted `linear-intake.integration.test.mjs`, `combined-sources.integration.test.mjs` | Actual association/mapping SQL; combined SDK reference, withdrawal, companion-event and narrowed-child admission | Synthetic provider association/membership; no contained child execution in combined suite |
| Hosted `session-journal.integration.test.mjs`, `session-timeline.integration.test.mjs` | Durable child/parent identity, optional issue association, ordering/dedup/authorization, timeline SQL | No native/provider event chain or rendered reload proof |
| Hosted `automation-result-wake.test.mjs` | Production callback commits before durable wake; failed wake requires receipt replay | DB and workflow mocked; no parent native successor consuming findings |
| CYPACK `apps/f1/native-context-join/` | Actual installed native/SDK/SQL/HTTP, memory/work, combined read/rotation/withdrawal/receipt recovery; new native bridge covers Linear/Slack queued events and direct/ticket children with durable session delivery | Does not emit signed provider webhooks or run production outbox dispatcher; fixed model/provider checks |

## Event scenarios already available

The full CYPACK native drive admits Slack/Linear opaque `trigger:event` inputs
through registered occurrence routes. It wakes idle work, holds one model turn,
queues another event, deduplicates its event ID, rejects changed payload409,
accepts older provider order without overwriting the active occurrence, runs another
customer independently, and recreates the runtime with retained queued work after
revoking old fixture grants. Later pause/foreign-context probes remain present.
Delivery boundary is **queued next occurrence**, not harness streaming.

Hosted optional installed-runtime modes are `linear-events`, `slack-events` and
`slack-channel-events`. They normalize synthetic provider events, call
`customer_ingest_connected`, create exact SQL outbox rows, deliver registered
occurrences, and assert arrivals during running work remain queued and two events
become processed. They include duplicate dispatch and lost result ACK. Their original model is a deterministic `next` implementation. The new
`run-hosted-native.mjs` bridge replaces only that model boundary with the installed
contained Codex process and synthetic Responses transport. It explicitly adds the
SQL preflight hook and enables session delivery for both event modes in its frozen
test copy. Original assertions remain, plus native execution/cleanup assertions;
the exact original/adapted sources are retained for review.

Implemented event shapes, from Hosted3b contracts (not a subscription assertion):

- Linear Issue create/update/remove normalize to issue-update routing; current
  customer associations are independently resolved. Comment-only Issue metadata
  does not create a duplicate comment trigger.
- Linear Comment create/update/remove retain identity; only qualified human create
  triggers wake. Edit/remove do not positively wake. Customer/CustomerNeed/Issue
  create/update/remove also feed durable intake reconciliation, not text authority.
- Slack human `message` in C/G channels, with root/thread timestamps. Bot IDs and
  any subtype are rejected. This does not include app_mention, DMs, edits/deletes,
  reactions or every Slack notification. Actual installed app subscriptions,
  permissions and qualifying signed deliveries still need separate verification.

Missing joined proof: signed HTTP → fresh customer/account mapping → durable
production wake/outbox → registered native execution → correctly scoped current
read → persisted response. Cover idle and active work, duplicate/out-of-order,
offline/restart, disabled notification, reassignment/withdrawal, bot echo and foreign
customer/workspace, separately for Linear comments/updates and Slack channel messages.
Provider-derived Linear CustomerNeed mapping and shared/ambiguous sources must remain
server-owned. Do not substitute an already-admitted event or manually inserted
outbox row for these missing upstream checks.

## Both investigation delegation paths

CYPACK full native drive requests `delegate_investigation` via actual SDK, direct
and assigned_ticket. Five tool calls (duplicates/lost ACK) yield two assignments;
children execute with separate scope/checkpoint/journal and retain parent/optional
issue identity. Direct children manufacture no Linear object. Ticket metadata is
synthetic and names an already-bound issue; no live ticket assignment is proved.
See historical `apps/f1/test-drives/cypack-1546-delegation.md` and contained-Codex report.

Hosted reusable modes: `direct-child`, `ticket-child`, `model-direct-child`,
`model-ticket-child`, `read-set-direct-child`, `read-set-ticket-child`,
`slack-channel-direct-child`. SQL commits exact child admission/outbox; model-requested
modes replay one operation key and assert one child. Child model context excludes
private parent text. Actual timeline asserts investigator role, parent/issue linkage,
one response and unique sequences; exactly one `automation.child.result` event is
stored. Lost activity/result ACKs remain covered. The new native bridge proves both read-set child modes execute actual contained
Codex, including tool calls and final findings, with those same SQL assertions.
The child outbox is still manually delivered; provider identities/model output
remain controlled.

Missing joined proof: production outbox delivery, interruption/current-authority
child resume, and a current parent successor actually consuming those findings.
The [engineering-to-parent acceptance recipe](engineering-parent-acceptance.md)
now identifies the exact production callbacks/dispatchers, one-customer fixture
and per-event replay assertions needed; that recipe is not a passing gate.
Both native direct and assigned-ticket child lifecycles, actual Hosted child
admission, durable findings and terminal lost-ACK recovery now pass. Include
combined parent→Linear-only child and worker widening denial; no sponsor/private
parent context. Ticket-backed proof must validate the current existing issue and
optional association without requiring a Linear agent session. Render/reload the
same durable parent/child sessions separately in Hosted UI. Live provider assignment
and customer-visible outcomes remain coordinator-owned acceptance, not fixture claims.

## Reproduction starting points (no live environment)

Full native Runtime fixture, after isolated install/import-root adaptation:

```sh
CYRUS_F1_CODEX_IMAGE=sha256:35ffa8e695666695f047cf527138b9b27f2e1c29d44673f9eb705a0e4010be4f \
CYRUS_TEST_DOCKER_HOST=unix:///approved/same-user/docker.sock \
node --input-type=module -e 'const {runAutomationDrive}=await import("/absolute/installed-automation-drive.mjs"); console.log(JSON.stringify(await runAutomationDrive()));'
```

Existing Hosted SQL/installed runtime modes, from a frozen disposable Hosted checkout
with existing dependencies/local disposable Postgres (not executed in this inventory):

```sh
CUSTOMER_TEST_FILE=automation.integration.test.mjs \
CUSTOMER_AUTOMATION_RUNTIME_MODULES=/absolute/isolated-prefix/lib/node_modules/cyrus-edge-worker/dist/automations \
CUSTOMER_AUTOMATION_JOINT_MODE=linear-events,slack-channel-events,read-set-direct-child,read-set-ticket-child \
bun --no-env-file tooling/test-customer-agents.mjs
```

Use current admission contracts and preserve existing assertions. Do not revive
retired approval continuations, mint broader grants, add a second scheduling engine,
or start a registered live instance to fill these gaps. Coordinator owns live gates;
Runtime owns native execution/replay and Hosted owns ingress/mapping/outbox/UI.
