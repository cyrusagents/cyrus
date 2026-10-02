# Customer-scoped runtime F1 drive

> Historical evidence for the immutable source below. The standalone command,
> service and driver were removed on October 1; these are not current setup
> instructions. See [registered automations](../../../docs/runtime-automations-v1.md)
> for the supported entry point. Original results are preserved.

Date: 2026-09-28 (America/Vancouver)
Tested implementation commit: `fc16b5a95fefeef8ce35a05faa26c7adf3936e0b`
PR: https://github.com/cyrusagents/cyrus/pull/1507
Issue: CYPACK-1546, dependency of CYHOST-1321

## Scope and evidence source

The changed workflow is the standalone `cyrus customer-runtime` service, not a
legacy Linear/Slack native runner. This drive exercises the production scoped
HTTP routes, scope/lifecycle enforcement, checkpoint store and Docker executor.
The model and hosted gateway are deterministic F1 fixtures. The engineering
container, code edit, test command and HTTP requests are real. There are no live
model API calls, customer contacts, provider PR writes, merges or deployments.

The local preinstalled `oven/bun:1.3.14` image was selected by immutable image ID.
No image was pulled. Temporary checkpoint state and containers were removed by
the drive. No credentials are included in this report.

## Reproduction

```sh
pnpm build
CYRUS_TEST_SANDBOX_IMAGE=sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 \
CYRUS_TEST_DOCKER_HOST=unix:///Users/agentops/.docker/run/docker.sock \
bun run apps/f1/scoped-runtime-drive.ts
```

Use the actual local Docker socket and an explicitly reviewed, preinstalled
image on another host. The runner does not automatically provision either.

## Assertions and results

- PASS: versioned capability discovery advertises the separate scoped runtime.
- PASS: launch rejects an additional malicious customer ID.
- PASS: another customer's resume cannot load a checkpoint.
- PASS: authenticated coordinator delegates an assignment; fixture hosted
  dispatch launches a separately authenticated engineering run. The model never
  receives the delegated run token.
- PASS: shared engineering model input contains only technical brief and
  synthetic reproduction, without the customer's private prompt.
- PASS: a real offline container changes `sum(a,b)` from subtraction to addition
  and runs a Bun assertion that `sum(2,3) === 5`.
- PASS: the engineering publication callback contains the repaired file;
  progress and final run results are delivered.
- PASS: a worker's support-send action never reaches the gateway action endpoint.
- PASS: two customers in one workspace and a customer in another workspace
  execute under distinct authenticated namespaces.
- PASS: interrupt aborts in-flight model work, and authenticated resume produces
  exactly one final result.
- PASS: live gateway revocation aborts in-flight work and denies both resume and
  result posting.

Output:

```text
PASS scoped launch, delegation, isolated edit/test, artifact, progress/result
PASS worker-write denial and two customers plus another workspace
PASS interruption/resume and live revocation denying resume/result
```

Additional verification: 60 scoped-runtime, real sandbox and legacy
chat/Zulip/resume regression tests; 160 CLI tests; build, typecheck and changed-file
Biome passed. The sandbox test actually asserts non-root UID, absence of host
paths and a synthetic inherited secret, denied root writes and denied external
network access. Recovery tests retain exact publication/result payloads and
idempotency keys after lost acknowledgements.

## Remaining integration gates

This is controlled runtime evidence, not live CYHOST-1321 hosted/provider proof.
The exact gateway schema was posted to that existing session for agreement.
Hosted must implement current-owner lease/CAS, action serialization and
idempotency/reconciliation, scoped provider reads, reviewed repository snapshots
and real engineering publication. The PR remains a draft pending that contract
and integration gate. No minimum published `cyrus-ai` version exists yet.

## Orchestrator follow-up: lease renewal and completed-run recovery

Tested implementation commit: `2645f787506238aed2cc2411ccc32e83fc5a380c`
Date: 2026-09-28, approximately 19:22 America/Vancouver.
The same reproduction command above passes against this commit. The original
drive and its evidence remain recorded above.

The expanded controlled gateway now enforces execution-owner fencing. Added
HTTP/lifecycle assertions pass:

- A resume using a new execution ID is denied while the existing owner is live.
- Explicit interrupt expires/fences that owner; runtime accepts an expired lease
  in the authenticated interrupt response and a new resume owner can proceed.
- A 400ms model turn survives its initial 150ms lease through authenticated
  renewals. The runtime no longer freezes the first lease deadline.
- A simulated lost result acknowledgement leaves a completed hosted run whose
  ordinary operation/progress paths reject further work. Resume uses the new
  `result` authorization phase and replays the exact persisted result/key with
  a new execution ID, without another model turn or progress callback.
- A subsequent locally completed resume returns completed without replaying
  either the operation or result callback.
- Missing-checkpoint admission is interrupted before admitting a new owner;
  this demonstrates that local rejection does not bypass hosted lease fencing.

Additional output:

```text
PASS renewable lease, fenced resume takeover, terminal receipt reconciliation and completed local resume
```

70 focused tests pass (31 runtime authorization/recovery tests plus real Docker
and existing chat/config/Zulip/resume tests). New tests additionally verify hard
token expiration despite lease renewal, shortened leases, rejection of late
renewals, takeover only after expiration/interruption, engineering terminal
receipt recovery with no sandbox available, and assignment generation/revision
fencing independent of sponsoring-customer withdrawal. Cross-customer/workspace
checkpoint tests and the complete entry-point inventory remain in place.
Build, typecheck and changed-file Biome pass. No hosted files were changed.

Shared engineering uses stable sponsoring `customerId` with zero customer reads;
top-level generation/policyRevision refer to the workspace assignment. Hosted
must implement these role-specific fences and terminal receipt semantics. The
gateway/model remain controlled fixtures; this does not claim connected hosted
or live-provider verification, release, merge or deployment.

## Review follow-up: ordinary engineering failures

Independent review identified that nonzero test exits interrupted the run and
replayed the same pending command. The corrected Docker execution envelope
returns exit code and separate bounded stdout/stderr, preserving file edits in
the checkpoint before another model turn. Infrastructure failures remain fatal.

Validation: 36 runtime/sandbox tests passed, including real Docker initially
failing `bun test`, persisted preceding edits, model-directed repair and passing
rerun. Real timeout, abort and output-overflow each reject and stop the container.
The production HTTP/runtime/Docker controlled F1 drive passed all four scenarios,
now including failure diagnostics and repair/retest before artifact publication.
The gateway/model are still controlled fixtures; actual hosted integration is
separately pending and no external model/provider calls were made.

Commands:

```sh
CYRUS_TEST_SANDBOX_IMAGE=sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 CYRUS_TEST_DOCKER_HOST=unix:///Users/agentops/.docker/run/docker.sock pnpm --filter cyrus-edge-worker test:run test/customer-runtime.test.ts test/customer-runtime-sandbox.test.ts
pnpm build
CYRUS_TEST_SANDBOX_IMAGE=sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 CYRUS_TEST_DOCKER_HOST=unix:///Users/agentops/.docker/run/docker.sock bun run apps/f1/scoped-runtime-drive.ts
```

## Connected hosted gateway and installed artifact (2026-09-29 UTC)

This section records the already-completed connected drive; no shared work was
repeated to prepare this report. Runtime implementation and installable artifact
source: `269e051d4a7190c46999ed38773297662dd526f3` (PR #1507).
Subsequent report-only commits do not change that tested implementation or artifact.

The driver imported the **isolated installed package**, registered production
runtime HTTP routes, used its private checkpoint store and executed commands in
real Docker containers. It called the actual hosted
`/api/customer-runtime/v1/{authorize,progress,engineering,result}` POST handler
and real local Supabase/SQL through `http://127.0.0.1:3022`. Hosted was an
uncommitted gateway slice on `8cef8367439cc9aaccb0ab68c574e4fd098babf2` (PR #1102);
its exact gateway, publication, fixture and migration file hashes are preserved
in `connected-evidence/hosted-source-identities.json` in the handoff below.

The model steps and GitHub transport were controlled fixtures with deliberate
lost acknowledgements; external network was denied by the hosted fixture. The
loopback HTTP adapter existed only in the test driver. Production HTTPS
validation was unchanged. There were no live provider/model calls or spend.

### Observed assertions

- Actual hosted admission denied a live different owner. Explicit interruption
  permitted a new resume owner, and the old owner's authorization was denied.
- A 92-second model turn survived the original 90-second lease through actual
  same-owner hosted renewals and runtime deadline updates.
- The reviewed inclusive-range synthetic test initially failed. Real sandbox
  diagnostics reached the model; the repair was checkpointed and its rerun
  passed using Bun's node:test compatibility runner.
- GitHub fixture created one PR and lost its acknowledgement. Runtime also lost
  the publication callback acknowledgement, preserving the pending publication.
  Hosted reconciled the exact PR; resume sent identical files/operation/key with
  a new execution ID and did not create another PR.
- Hosted committed the result and lost its acknowledgement. Recovery resent the
  immutable result/key under a new owner, without another model turn, sandbox or
  progress callback. Locally completed recovery repeated no result callback.
- The second customer's active engineering assignment was revoked; its runtime
  stopped and resume was denied. Engineering read/action/delegate requests were
  denied. The unrelated workspace's result remained separate.
- Three distinct runtime checkpoints were private, owned by the runtime UID and
  scoped to the authenticated customer/workspace/run identities.
- Durable evidence contained one succeeded publication and five scoped events:
  publication plus findings for each of the two sponsoring customer threads,
  and one findings event for the other workspace. No revoked-run result existed.

The drive's last aggregate receipt assertion initially expected three events,
not the five emitted after hosted added publication fanout. The original failure
is preserved in `summary.json` and `connected-drive.log`; **all runtime execution
assertions above passed before that assertion**. A corrected type-specific
verification was then executed against actual hosted durable evidence and passed:
exactly two publication events, two sponsoring findings events and one separate
workspace finding across three distinct threads. The verifier also checks one
PR, publication identity, undeployed status and no result from the revoked run.
See `receipt-verification.json` and `hosted-receipts.json`. The driver now uses
those explicit assertions for future fresh-fixture runs.

Hosted's owner subsequently exercised its actual `runCustomerAgent` coordinator
loop against real local Supabase with a controlled Anthropic transport. Its
`/tmp/cyhost-1321-coordinator-evidence.json` records both sponsoring coordinators'
result/memory acceptance, denied cross-customer source-event memory attempts,
retained unrelated billing threads and no deployment or objective-closure claim.
That coordinator fixture is hosted-owned; this runtime agent did not execute or
modify it.

### Installable artifact and reproducibility

Complete 17-package bundle, with staged unpublished test versions and exact
internal dependencies (not registry fallback to older Cyrus packages):

```text
/Users/agentops/.cyrus/CYPACK-1546/attachments/runtime-handoff/bundle/cyrus-0.2.72-cypack1546.269e051d4a71-test-bundle.tar.gz
SHA256 e97592e143037a339495176eea78b0e73c627d701331f141d9d8a1533aba8de7
```

Portable credential-free handoff containing that artifact, per-package manifest,
build/install/start instructions and scripts, installed-CLI discovery proof,
connected driver, original log, corrected receipt validation and source hashes:

```text
/Users/agentops/.cyrus/CYPACK-1546/attachments/runtime-handoff-269e051d.tar.gz
SHA256 7641b1cffbddcfdf192e53b32a693c942fec29ccb6b5deb3d5acc5132851dbc0
```

The handoff excludes installed state/configs and private capabilities; an exact
fixture/control-token scan passed. Both archive hashes were reverified for this
report. The independent owner must copy it into
`/Users/Shared/cyrus-verifier/CYHOST-1321/`; that directory is outside this runtime
agent's writable roots.

Build prerequisites used: Node 26.5.0, npm 11.17.0, pnpm 10.33.1. Node 22/24 CI
also passed the exact source. From a clean checkout of the source SHA, the
included `build-local-artifact.mjs` installs the frozen lockfile, builds, packs
the canonical graph and verifies the bundle; it never publishes. Rebuilding can
change archive timestamps/hashes. Verify the supplied archive against its hash.

```sh
node /absolute/runtime-handoff/build-local-artifact.mjs \
  /absolute/clean/cyrus 269e051d4a7190c46999ed38773297662dd526f3 \
  /absolute/new-bundle-output
# After extracting the supplied test bundle:
bash install.sh /absolute/new-disposable-prefix
```

Historical local Docker identity (the local execution used Linux arm64):
`sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4`
(`oven/bun:1.3.14`, recorded by the local daemon). This digest identifies a
multi-platform OCI index; it must not be described as an arm64-only image or
assumed to be the amd64 local config ID. See
[CI artifact/image bootstrap](../../../docs/customer-runtime-ci-artifact.md)
for pinned platform manifests and local image verification. No image was pulled
during the historical runtime drive. The reviewed image
provides `/usr/bin/env`, `/bin/sh` and `/usr/local/bin/bun`; operator review must
ensure no secrets or declared volumes. Test socket:
`unix:///Users/agentops/.docker/run/docker.sock`; binary `/usr/local/bin/docker`.

Start the installed service using the mode0600 explicit configuration described
in `docs/customer-runtime-v1.md` and the handoff README:

```sh
/absolute/new-disposable-prefix/bin/cyrus customer-runtime --config /private/runtime/customer-runtime.json
```

Actual installed production CLI startup, Docker probe and discovery passed.
Discovery advertises v1, `leaseRenewal:true`, `resultReconciliation:true` and
engineering isolation; unknown contract and forged scope are denied. All 17
consumer dependency resolutions/provenance were checked. A separate read-only
smoke exercised actual hosted `queueEngineering` source with HTTP/database
imports stubbed: 17 old/unsupported/unsafe discovery cases were rejected before
queue writes, including old-runtime 404 and missing renewal/reconciliation.
Valid discovery reached only the synthetic queue. This is controlled gate
verification, not another live deployment.

### Remaining limits and rollout

No minimum published `cyrus-ai` version exists; the `-cypack1546.*` identity is
unpublished test metadata. This proves connected controlled integration, not a
published-hosted-head deployment, live-provider acceptance or customer outcome.
Connected pause/policy-change/sponsor-withdrawal checks and final hosted
checkpoint/preview acceptance remain separately owned and pending. Their existing
unit/SQL coverage is not represented as connected runtime proof.

Rollout remains: additive hosted gateway/storage with dispatch **disabled** →
install exact scoped artifact/image and verify all v1 capabilities → joint test
and independent exact-head review → explicit operator enablement. Unsupported
or old runtimes stay unavailable; there is no legacy-runner/session fallback.
Rollback disables dispatch first, fences owners, stops scoped services/reaps
orphan containers, preserves checkpoints/receipts and reconciles uncertain
publications. An older scoped build is eligible only if every required capability
passes. No merge, registry publication, release or deployment was performed.
