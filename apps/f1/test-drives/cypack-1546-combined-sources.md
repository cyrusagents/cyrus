# CYPACK-1546: combined customer sources through installed native execution

Date: 2026-10-01. F1 applies because provider grant composition, SDK reference routing,
negotiation and checkpoint/recovery behavior changed. This extends the existing
native-context driver; it does not create another scheduler or authority engine.

## Exact inputs

- Installed runtime: `4733183c20d259e2b7f383c9e447d8bf565276f3`.
- Driver: `a65cf368d1dca55b4441167f7d901bd607a401b4` (test-only changes after473).
- Hosted: `e0785a1d07989757dbc2306984ba523a89d26532`, archived into a disposable checkout.
- Bundle SHA256: `9cc84e26363c159c4e4a99de3d85ee990a479ad221bb3f7fb6dacd758ca11347`.
- Image: `sha256:35ffa8e695666695f047cf527138b9b27f2e1c29d44673f9eb705a0e4010be4f`, Linux arm64, no volumes.
- Provenance:17 packages/17 isolated installed copies matched `cyrusLocalTestArtifact.sourceSha`.

## Reproduce

Use the prerequisites and cleanup in [the committed driver README](../native-context-join/README.md).
Run from a checkout containing drivera65, with a verified installed473 prefix:

```sh
CYRUS_NATIVE_JOIN_COMBINED=1 \
CYRUS_TEST_DOCKER_PATH=/usr/local/bin/docker \
CYRUS_TEST_DOCKER_HOST=unix:///AUTHORIZED/SOCKET \
CYRUS_F1_CODEX_IMAGE=sha256:35ffa8e695666695f047cf527138b9b27f2e1c29d44673f9eb705a0e4010be4f \
node apps/f1/native-context-join/run.mjs /absolute/hosted-checkout \
  e0785a1d07989757dbc2306984ba523a89d26532 /absolute/installed473 \
  4733183c20d259e2b7f383c9e447d8bf565276f3 /absolute/new-evidence
```

## Results

PASS:11 completed occurrences,24 native model requests,111 ordered delivery calls,
61 persisted activities/11 sessions,13 result transmissions. See
[summary](evidence/combined-customer-sources/summary.json) and
[provenance](evidence/combined-customer-sources/provenance.json).

- Initial HTTP admission advertises renewal. The runtime automatically continues
  the one initialized SDK session across3 credential rotations; both bindings stay
  identical. A47-second native model delay precedes successful issue/thread reads.
  The combined read completes attempt1. Both bodies reach the model, and crossed
  issue/thread references produce denials. Actual Hosted tool counts include
  `read_messages:1`, `read_thread:1`, `list_issues:2`, `get_issue:2` (including survivor).
- Removing the secondary mapping through `customer_remove_source` after result
  commit but before a deliberately lost ACK does not rewrite the original pair or
  native envelope. Receipt-only recovery completes attempt2/fence2, one model open.
  A new revision/occurrence reads Linear, lacks Slack tools, and cannot retrieve
  the mixed-source memory.
- Existing memory ACK loss recovers one effect with a fresh native transcript;
  later recall, proof-linked work verification and a separate terminal ACK loss
  after policy change remain green. No pending-approval execution returns.
- 76 focused runtime tests passed/1 opt-in skip; build/typecheck and Node22/24 CI
  passed at tested runtime/driver heads. Installed standalone native-context F1
  also passed4 occurrences/7 model requests/3 writes/41 deliveries.

## Failures found and preserved

The first joined473/d9cdc111 run and a diagnostic replay failed: native admission
returned `sessionRenewal:false` initially and overwrote provider renewal support.
The client correctly reconnected, so its old issue reference could not read. The
final model-body assertion correctly detected the failure; it was retained.
Hosted684fc65d corrected initial negotiation. The next joined gate passed reads but
found terminal `slackChannelRead` derived from the current binding rather than the
saved pair. Hosted e0785a1d corrected receipt metadata without restoring MCP access.
The final run above passes both corrections. Runtime artifact/hash never changed.

Full failed/success logs, hashes, installer and handoff are retained in
`/Users/agentops/.cyrus/CYPACK-1546/attachments/combined-sources-4733183c/`.
No earlier report/evidence was overwritten.

## Limits

Actual registered runtime routes/SQLite/private checkpoints, MCP SDK, contained
Codex/Docker, Hosted HTTP/session/MCP handlers and migrated SQL are exercised.
Model/provider transport, outbox inputs, outcome proof production and survivor
configuration resolution are controlled fixtures. This does not prove live
provider membership, UI, production dispatch, or active-withdrawal causality before
completion. Generic worker/child scope and malformed-grant denial have runtime
regressions; Hosted's separate combined SDK/SQL suite covers narrowed child admission.
No live customer prompts/provider effects, runtime installation/restart,8007 replay,
merge, release or minimum published version is claimed. Coordinator-owned independent
and live acceptance remain separate.

## Explicit Hosted POST preflight join — 2026-10-01

- Immutable driver: **5bf0d0c0347e4ae1cb5403a91528804414701558**.
- Unchanged installed runtime: **04e941be8b5176e7f54fa1174179b8be78f78fc3**,
  bundle SHA2568aff9c3517597239a1a07c891261ad9935b9a4fb9240f4037b019ab546aa8b3c.
- Frozen Hosted: **3b5b437f782d96ef7aab9338d3de688874bd1b5f**.

Changed only the join gateway fixture: its existing database-only authorizer now
also serves the optional `preflight` hook. Separate full `authorize` calls remain.
Positive counters are required, so a handler ignoring preflight fails this gate.
The original helper's SQL/native/source checks, native body/reference assertions,
47-second wait, rotation, withdrawal, memory/work and receipt assertions are intact.
No Runtime production source, dependencies or artifact changed after04e.

Actual installed/native/SQL/SDK join **PASS**,80.56s:11 completed occurrences,
24 model exchanges,111 ordered deliveries,61 persisted activities/11 sessions,
13 result transmissions.289 preflights/300 full authorizations (includes non-POST
requests; not a1:1 latency comparison). Combined read completes attempt1, one SDK
session,3 authenticated rotations and both bodies/cross-reference denial present.
Lost terminal ACK plus secondary mapping removal recovers the immutable two-source
receipt without another model open; fresh survivor has Linear only/mixed memory
hidden. Lost memory ACK still causes one effect/fresh transcript; work proof/linkage
and separate terminal policy-change reconciliation remain covered.

Exact command, from driver5bf0d0c0:

```sh
CYRUS_NATIVE_JOIN_COMBINED=1 \
CYRUS_TEST_DOCKER_HOST=unix:///var/run/docker.sock \
CYRUS_F1_CODEX_IMAGE=sha256:35ffa8e695666695f047cf527138b9b27f2e1c29d44673f9eb705a0e4010be4f \
node apps/f1/native-context-join/run.mjs \
 /absolute/hosted-checkout 3b5b437f782d96ef7aab9338d3de688874bd1b5f \
 /absolute/installed-04e-prefix 04e941be8b5176e7f54fa1174179b8be78f78fc3 \
 /absolute/new-evidence
```

Use the runner's approved same-user Docker socket. The source launcher archives
Hosted; no edit to its worktree or live state. Output/provenance and hashes of all
four driver files are committed under `evidence/preflight-native-join/`.
Provider/model transport, outcome proof generation and outbox remain controlled.
This join does not exercise production `mcp-store.ts` provider verification latency,
production signed ingress/outbox dispatch, UI or live customers. Withdrawal occurs
after the selected terminal commit, not an independent active-revocation proof.
The installed04e artifact remains the reviewed one; no new package build is needed.

The reusable event/delegation fixtures and missing combined native/Hosted proof are
inventoried in [automation-event-delegation-coverage](../../../docs/automation-event-delegation-coverage.md).
That inspection does not mark event or delegation live checklist gates accepted.
