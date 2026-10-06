# Registered factory preparation regression

CYPACK-1546 / [PR #1507](https://github.com/cyrusagents/cyrus/pull/1507).

Executable and candidate driver: `f01de2a2992fd8f3d50daa7858a02a5f83aba382`.
Baseline executable: `9e15c7bf36d149c20782f8e31d55328b845766e5`.
Node26.5.0; isolated `/tmp` installs,17packages/17resolved copies verified.
No live runtime, customer, credential or provider access. F1 applies because the
registered model lifecycle and its fixture entry point changed.

## Failure and fix

The registered factory omitted the contained adapter's `nextAuthorization`
capability. Live execution therefore waited for context preparation and then
made a separate model-entry catalog request. Earlier profiles instantiated the
contained adapter directly, missing this wiring. E41 live timing demonstrates
the corresponding serial checks at12.313–13.457s and13.486–15.274s.

The factory now advertises the actual contract: pure `open`, followed by an
authorizing `next`. Startup login readiness and per-request broker credential
validation remain; the redundant credential readiness read during `open` moves
out of that path. Registered Messages mode also authorizes before sending; bare
model execution without an admitted context fails closed. No authority is cached
after completion. No Hosted wire, tool permissions or receipt protocol changed.

## Installed F1

`CYRUS_F1_REGISTERED_RUNTIME=1` uses **registerConfiguredAutomations**, its actual
readiness probes, HTTP admission/status routes, SQLite, checkpoint/journal,
MCP SDK, native Docker process and login broker. The control plane/provider/model
transports and private login are synthetic. Each profile executes cold/warm Hi
occurrences with a fresh context read, no model-selected tools, and ordered final
receipts. Both actual authority barriers around native capture remain asserted.

500ms Hosted fixture delay; MCP delay applies per HTTP request:

| MCP delay | Turn | Catalogs before → after | Pre-native seconds before → after | Runtime seconds before → after |
| --- | --- | --- | --- | --- |
|150ms|cold|9 → 8|2.992 → 2.802|6.324 → 6.089|
|150ms|warm|9 → 8|2.976 → 2.795|5.755 → 5.594|
|1500ms|cold|10 → 9|13.944 → 12.361|23.993 → 22.389|
|1500ms|warm|10 → 9|13.853 → 12.460|23.460 → 21.998|

Each pair:2model exchanges,2context reads,2result commits/2transmissions,
15activity deliveries,2MCP initializations,attempt1,no dropped spans. The slow
profiles include watchdog work. This establishes one avoided serial request,
not a universal latency gain or live acceptance. Baseline adapted driver bytes
and their hash are preserved; subsequent driver differences are formatting and
the comment identifying the historical legacy wrapper. Candidate driver is frozen
at the executable commit.

Focused tests:102passed/1optional skipped across automations and delivery authority;
15broker tests passed (including changed account/private credentials, revocation
and response withholding); the optional real Docker test then passed, extended
to deny revoked registered Codex before container startup or credential access.
Registered Messages tests cover held authorization, revocation and abort.
Commit hooks passed lint, build and typecheck. No unchanged broad join rerun.

## Reproduction and artifact

Bundle: `cyrus-0.2.73-cypack1546.f01de2a2992f-test-bundle.tar.gz`.
SHA256: `80cb0862fc8c98999741952081d8b778acc5db1c371c06d58f632b4b378aa14f`.
Evidence/HANDOFF under
`/Users/agentops/.cyrus/CYPACK-1546/attachments/registered-preparation-f01de2a2/`.
No registry publication; minimum published supported version remains unspecified.

```sh
CYRUS_F1_REGISTERED_RUNTIME=1 CYRUS_F1_LIFECYCLE_AUTHORITY=1 \
CYRUS_F1_HOSTED_DELAY_MS=500 \
CYRUS_F1_CODEX_IMAGE=sha256:35ffa8e695666695f047cf527138b9b27f2e1c29d44673f9eb705a0e4010be4f \
node apps/f1/catalog-profile.mjs /absolute/isolated/prefix \
  f01de2a2992fd8f3d50daa7858a02a5f83aba382 /absolute/new/evidence context
```

Set `CYRUS_TEST_DOCKER_PATH` and `CYRUS_TEST_DOCKER_HOST` for the authorized test
daemon. No network/pull/mounts/volumes in contained execution. Existing live
3456/4444 remain untouched; independent replay and coordinator installation are
still required. Remaining live cost includes fresh admission/source/catalog
checks, context retrieval and final delivery. E41's43.814s DOM versus25.228s
runtime difference is not assigned to a single cause by these spans. Historical
44s startup likewise remains unattributed.
