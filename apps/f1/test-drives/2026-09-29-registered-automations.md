# Queued events and terminal receipt follow-up

The expanded registered-HTTP F1 passes instruction, real clock tick, synthetic admitted
Slack/Linear event idle wake, active-turn queue, duplicate/late-arrival input, another
customer filling the free workspace slot, restart retention, pause denial and isolated
model contexts. Counts:7 committed results,8 transmissions,9 MCP reads,15 model steps.
Actual provider ingress/signatures/subscriptions remain Hosted-owned and are not claimed
by this synthetic-input test. Final acceptance includes the connected event-driven path;
instruction/tick alone is a milestone.

Terminal result receipts are marked durably before first send, with original definition
and checkpoint plus a separate three-attempt budget in the same SQLite occurrence.
Paused/deleted/edited definitions and model unavailability do not cancel receipt recovery.
Restart tests retain original revision/payload/key, acquire a new attempt, and reopen no
model/progress/tools. Missing or mismatched terminal checkpoint fails closed.

Validation before publication:30 generic/SDK tests pass on Node22; full edge-worker suite
906 passed,6 skipped on Node26. Node22 CI teardown hang was reproduced after successful
abort assertions and fixed with forced fixture connection cleanup. No runtime rejection
suppression was introduced. Current-head CI and immutable artifact/Hosted rerun evidence
must be recorded before acceptance. Previous artifacts/evidence follow unchanged below.

---

# Intermediate runtime checkpoint: dd0a6caf

Implementation/artifact source: `dd0a6cafb6051d138d38cf88b5160b2dff37562d`.
The earlier e4de bundle below is superseded for connected acceptance. Joined testing
found an unhandled Node rejection when the SDK cancelled a transformed GET405 body.
The runtime now buffers bounded JSON bytes before SDK consumption. The regression
includes real network GET405 bodies, oversized responses and an aborted pending call;
all pass without suppressing unhandled rejections. Full edge suite:901 passed,
6 skipped; full build/typecheck pass.

[Current F1](evidence/registered-automations-dd0a6caf/summary.json) uses real HTTP
requests to production registered definition/enqueue/status routes. Operator instruction,
clock-generated tick, non-customer work and result-ACK recovery pass (4 commits,
5 transmissions). Handler choice remains the shared server's route-registration
lifecycle, with one SQLite scheduling ledger and no customer policy in CYPACK.

Replacement17-package bundle:
`/Users/agentops/.cyrus/CYPACK-1546/attachments/automation-dd0a6caf/cyrus-0.2.72-cypack1546.dd0a6cafb605-test-bundle.tar.gz`

SHA256: `a2f5c978043028deb06067153c94034e9682ec6584d86ae47e5f3719f026a39d`.
[Fresh isolated install/provenance](evidence/registered-automations-dd0a6caf/package-verification.json)
and [installed registered discovery](evidence/registered-automations-dd0a6caf/installed-smoke.json)
pass. Use the build/install procedure below with dd0a's full source SHA and new paths.
The existing e4de/269e artifacts remain preserved. No minimum published version.

Hosted's exploratory SQL/HTTP joined test passed instruction+due tick, four scoped
reads across token rotation, two authoritative messages and automatic lost-result-ACK
recovery (three result transmissions, six model steps). That exploratory run lacked
frozen source hashes. An exact installed-dd0a rerun through registered HTTP routes is
being coordinated; it must be recorded against an immutable hosted head before claiming
joint acceptance. Authority/model/provider fixture and production-registration limits
remain explicit. No release, merge, deployment or live provider effects.

---

## Historical e4de evidence

# Registered automations: instruction, tick and scoped MCP

Runtime implementation: `e4de0e6707ab82d5ef8ec56509e6abe947b884c0` (PR1507).
This tests the redesigned registered-runtime architecture. Historical 269e Docker
acceptance remains separate and does not establish this architecture's acceptance.

Full edge-worker regression suite: 901 passed, 6 skipped. All four Node 22/24
PR/push CI jobs passed at the implementation head. Full build/typecheck and audit passed.

## Scope and result

PASS: operator instruction and real clock-generated tick through production generic
runtime routes, private SQLite, configured Messages adapter, MCP SDK HTTP transport,
private checkpoint and durable result. A non-customer automation uses the same engine.
The authority/model/provider transports are controlled; external network is denied.
No live provider/model calls or customer writes occur.

Reproduce from the implementation head:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm --filter cyrus-edge-worker exec vitest run test/automations.test.ts test/automation-mcp.test.ts test/customer-runtime.test.ts
node apps/f1/automation-drive.mjs
```

The [summary](evidence/registered-automations-e4de0e67/summary.json) records 4 result
commits and 5 transmissions. Lost-result-ACK restart recovery performs no additional
model, progress or MCP work. It also covers duplicate delivery, customer/namespace
separation, copied-live-instance denial, forged scope, expiry/revocation on existing
sessions, fixed-resource arguments, no supervisor credentials in MCP and no credentials
in checkpoints. Generic unit tests cover durable lease takeover, revisions, pause,
offline coalescing, bounded queues and cross-workspace checkpoint identity.

The real SDK regression deliberately pauses initialization and a slow write response,
requests supervisor renewal while each is pending, and verifies rotation waits. Reads
before/after rotation use distinct sessions with one stable grant. A lost write ACK
retains the same payload and idempotency key on reconciliation: two intended writes,
two commits. Revoked sessions reach no provider.

## Actual hosted transport interoperability

The [interop probe](evidence/registered-automations-e4de0e67/hosted-source-interop.json)
uses this runtime client with hosted's actual `createCustomerMcpHandler` SDK server
and `readMcpResource` result validator. Reads before/after token rotation passed with
identical stripped results, two initializations/two provider reads, and subsequent
revocation denied provider access. Hosted worktree source hashes are recorded.
Admission/session storage is controlled in memory; provider responses are synthetic.
This is not immutable hosted-head SQL/admission or full joined workflow proof.

## Installable test artifact

Local bundle:
`/Users/agentops/.cyrus/CYPACK-1546/attachments/automation-e4de0e67/cyrus-0.2.72-cypack1546.e4de0e6707ab-test-bundle.tar.gz`

SHA256: `6edb7f046bb150d3562fc8e0377a36c627e0b00681843ae3201ea22f66a8b31c`.
Builder source is committed at `scripts/build-local-artifact.mjs`. Rebuild:

```sh
node scripts/build-local-artifact.mjs "$PWD" e4de0e6707ab82d5ef8ec56509e6abe947b884c0 /tmp/new-automation-bundle
```

Extract the archive into a new directory, enter its `cyrus-…-test-bundle` subdirectory
and run `bash install.sh /tmp/new-runtime-prefix`. Verify with:

```sh
node /path/to/cyrus/scripts/verify-local-artifact.mjs "$PWD" /tmp/new-runtime-prefix e4de0e6707ab82d5ef8ec56509e6abe947b884c0
/tmp/new-runtime-prefix/bin/cyrus --help
```

All 17 packages and installed consumer resolutions/provenance passed verification;
[installed capability discovery](evidence/registered-automations-e4de0e67/installed-smoke.json)
reports contract 1, scoped MCP, scheduling and result reconciliation. Forged/absent
supervisor authentication rejects. This slice requires Node 22+ with built-in SQLite;
local build/install used Node 26.5.0. No Docker prerequisite for this generic read slice.
Engineering remains false; the historical Docker image is not silently invoked.
No package was published and no minimum published version exists.

Start the installed CLI through the existing paired workspace setup and configured
compatible explicit Claude model/API connection. No new listener or customer-runtime
configuration is introduced. Authenticated `/api/automations/v1/capabilities` must
report available before hosted delivers/enables work. Unsupported readiness fails
closed. Keep feature disabled during install/discovery; joint verification precedes
explicit enablement. Rollback pauses definitions/revokes grants before replacing the
runtime and never redirects scoped work to legacy runners.

## Remaining gate

Actual connected hosted authorize/progress/result + SQL + MCP, immutable hosted head,
visible instruction/tick results and independent verification are still required.
Hosted owner is wiring that fixture against the exact bundle above. Multi-resource
capabilities and engineering in the generic lifecycle remain unavailable. No merge,
production enablement, release or live unrelated provider effects are authorized.
