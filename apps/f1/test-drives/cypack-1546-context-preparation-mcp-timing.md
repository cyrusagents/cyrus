# CYPACK-1546: pending context preparation and MCP timing

Runtime executable and driver: `9e15c7bf36d149c20782f8e31d55328b845766e5`.
Preparation-only executable: `02d5be94119e596678099fd686af0bc684cda650`.
Hosted: `014ef20647a2f7bcf87ec3a8961121a700392a19` for timing;
`107272ba0f71a339435a0e84677f6b504fefa99c` for full context regression.
No live installation, prompt, retry or provider effect.

The changed behavior requires F1: local context checkpoint preparation can
proceed while its current source check is pending. The contained adapter's
model entry requests authority and joins only a still-pending request; a
completed check cannot be cached. Context activity stays behind the source
check. Legacy/unknown adapters remain serial. Focused tests reproduce the old
serialized preparation, then verify withdrawal/abort denial, no early context
activity, and a new model-entry check after an earlier request has settled.

105 focused tests passed; one separate opt-in native test skipped. Real native
Docker is exercised by both installed joins below. Normal lint/build/typecheck
hooks and exact executable Node22/24 CI passed. Each bundle was installed into
a new `/tmp` prefix and verified as17 packages/17 resolved copies.

## Installed joins

- Preparation02d + Hosted1072: **PASS133.90s**,15 completed/2 intentional paused
  callbacks blocked,38 model exchanges,180 activity receipts,18 result
  transmissions. Retained47s renewal, reference continuation, secondary-source
  withdrawal, source-free/provider-bound work rejection and correction,
  immutable negative/positive lost ACK recovery, proof-gated work and terminal
  receipt-only reconciliation.
- Runtime9e15 + Hosted014ef: **PASS56.07s**,8 completed/2 intentional blocked,
  14 admissions/75 checkpoint checks,13 model exchanges,82 receipts,10 result
  transmissions. Actual handler timing headers pass through the real SDK into
  numeric runtime status. Catalog/call spans contain preflight, authorize, SQL
  and total separately from overall transport time; initialize is not assigned
  a single response's timing. Malformed/oversized/unknown/unauthenticated reader
  cases, ordinary requests without opt-in, real SDK renewal/revocation and
  private retention recreation have focused coverage.

These use installed runtime classes, actual sealed native container and frozen
Hosted HTTP/MCP/SQL. Model, provider verification and admissions are controlled.
They do not measure live provider connection costs or establish live latency.

## Controlled before/after

Same committed driver, automatic context included;500ms supervisor delay and
150/1500ms MCP delay. Baseline6a vs preparation02d:

| MCP delay | Cold catalogs | Warm catalogs | Warm pre-native | Warm total |
|---|---|---|---|---|
|150ms|9→8|9→8|3065→2774ms|5984→5548ms|
|1500ms|10→9|10→9|13883→12291ms|23443→21802ms|

The slower case includes a watchdog check. After-profiles overlapped an isolated
SQL join; cold150ms total regressed6386→7160ms. The deterministic finding is one
catalog removed per turn, not a universal timing improvement. A first baseline
profile failed an overly broad interval assertion without retaining its exact
failing span. That failure remains preserved; the corrected assertion covers
only authority/catalog/snapshot barriers with0.002ms rounding tolerance.
Ordered final receipt assertions remain intact.

Latest passive live1072/6a greeting still took35.777s foreground,24.069s runtime;
nine catalog spans totaled12.357s, native initialization approximately0.35s.
Responsiveness remains unaccepted. New MCP metrics are optional bounded
telemetry, never permission caching or model inputs. Nested server metrics
must not be summed as independent work.

## Reproduction and evidence

Author attachment root:
`/Users/agentops/.cyrus/CYPACK-1546/attachments/mcp-timing-9e15c7bf/`.
`HANDOFF.md` includes build/install/image/replay commands;
`native-join/joined-summary.json`, `joined.log`, `installed-provenance.json` and
`driver-provenance.json` preserve exact evidence. Preparation evidence lives in
sibling `context-preparation-02d5be94/`; numeric profiles in
`context-profile-6a09-before-v2/` and `context-profile-02d5-after/`.

Timing gate:

```sh
CYRUS_NATIVE_JOIN_MCP_TIMING=1 \
CYRUS_NATIVE_JOIN_LIFECYCLE_AUTHORITY=1 \
CYRUS_TEST_DOCKER_PATH=/usr/local/bin/docker \
CYRUS_TEST_DOCKER_HOST=unix:///var/run/docker.sock \
CYRUS_F1_CODEX_IMAGE=sha256:35ffa8e695666695f047cf527138b9b27f2e1c29d44673f9eb705a0e4010be4f \
node apps/f1/native-context-join/run.mjs HOSTED_CHECKOUT \
  014ef20647a2f7bcf87ec3a8961121a700392a19 INSTALLED_PREFIX \
  9e15c7bf36d149c20782f8e31d55328b845766e5 NEW_OUTPUT
```

Unpublished test bundle SHA256:
`694f2948b40d9c251870f1c9476709559a617e291d09bad04108ed2a4c0af94a`.
No minimum published version or release is claimed.
