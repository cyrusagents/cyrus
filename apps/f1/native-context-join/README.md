# Installed native context + Hosted SQL join

This F1 runs installed production Runtime classes and routes, SQLite/private
checkpoints, MCP SDK HTTP transport and the contained Codex process against actual
Hosted automation/MCP/session handlers and migrated PostgreSQL. Model responses,
provider membership checks, event outbox admissions and outcome proof production
are synthetic. It makes no live provider calls and uses no real model login.

Prerequisites: Node, Bun, Git, existing Hosted dependencies, a local PostgreSQL
server with disposable-database privileges, a verified 17-package runtime test
installation, and an authorized Docker socket with the reviewed image preloaded.
The Hosted test harness refuses remote database hosts, creates a fresh database and
drops it afterward. Do not point this at a live runtime or home directory.

```sh
CYRUS_TEST_DOCKER_PATH=/usr/local/bin/docker \
CYRUS_TEST_DOCKER_HOST=unix:///var/run/docker.sock \
CYRUS_F1_CODEX_IMAGE=sha256:35ffa8e695666695f047cf527138b9b27f2e1c29d44673f9eb705a0e4010be4f \
node apps/f1/native-context-join/run.mjs \
  /absolute/hosted-checkout FULL_HOSTED_SHA \
  /absolute/isolated-installed-prefix FULL_RUNTIME_SHA /absolute/new-evidence
```

The launcher archives that exact Hosted commit into a temporary directory, reuses
its installed dependencies and adds only this test fixture. It does not edit the
Hosted checkout. The runtime installation must report the supplied immutable
`cyrusLocalTestArtifact.sourceSha`. Production HTTPS validation is unchanged: a
test-only fetch bridge maps the fixed `https://native-join.invalid` origin to the
loopback handler and rejects other network access; the synthetic model responder
intercepts only the configured Codex responses endpoint.

All registrations and controls exist only in this disposable loopback fixture.
Private temporary files contain synthetic credentials only. Runtime, server,
database and source snapshot are stopped/removed after the test. The private
temporary fixture directory is retained for debugging; remove the printed path
after investigating any failure. Evidence contains no tokens, customer text or
native transcript. The image uses no mounts, container network or image pulls.

Assertions cover ordinary memory write and later recall; a lost write ACK with
same operation identity, fresh native transcript and current context on recovery;
work create then proof-linked verified transition; source-derived memory hidden
after mapping withdrawal/new revision; and a lost terminal result ACK reconciled
after policy change without reopening the model. Final results require ordered
durable session ACKs. Retired approval tools must be absent. The old MCP connection
denial is checked after its occurrence has completed as well as source withdrawal,
so it is not independent proof of active-grant withdrawal causality.

`CYRUS_NATIVE_JOIN_LOSE_WRITE_ACK=0` explicitly selects a **partial** direct-path
gate. The summary labels that exclusion. Use it to isolate a recovery defect;
never report it as the full recovery gate. Historical installed `6ce46473` against
Hosted `24a4b7e0` passed the direct path but the full gate exposed SQL
`Native session identity changed` on lifecycle sequence 12 after fresh-context
recovery. Hosted owns that correction; do not restore withdrawn native transcripts
or bypass ordered ACKs to pass the test.

This gate does not prove live provider membership, production dispatcher wake,
browser persistence/UI, active source withdrawal or engineering publication. Those
retain their separately labeled acceptance evidence. No release or published
minimum runtime version is implied.


Set `CYRUS_NATIVE_JOIN_COMBINED=1` with a Hosted head containing
`customer_sources_admit` to extend this same installed native gate with the negotiated
Linear+Slack pair. It reads both providers using actual Hosted read adapters with
synthetic provider transport, delays a native model response 47 seconds across
same-session renewal, rejects crossed issue/thread references, writes mixed-source
memory, then loses a terminal ACK while removing the secondary mapping through
`customer_remove_source`. Receipt-only recovery retains both original bindings;
a fresh survivor occurrence reads Linear and cannot see the mixed-source memory.
The fixture mirrors the current definition resolver after removal; it does not
exercise production outbox dispatch or live provider membership.

The combined gate also requires the **initial HTTP admission** to advertise
`mcp.sessionRenewal:true`. It then asserts the runtime automatically supplies its
initialized session ID at renewal, the new token differs, both resource bindings
stay identical, and only one SDK session/model attempt serves the delayed read.
A manual fixture renewal with a supplied session ID is insufficient. The final
model-input assertions for both source bodies and crossed-reference denials remain
mandatory; only finite diagnostic flags are retained in the summary.

The gateway explicitly supplies its existing **database-only** authorizer as
`preflight`, enabling Hosted3b5b437f's pre-body POST path. It separately supplies
`authorize` to retain full SDK calls. Evidence requires positive `mcpPreflights`
and `mcpAuthorizations` counts. This fixture exercises actual handler/SQL framing;
provider membership is still synthetic, so the counts are not proof of production
provider-verification latency or coverage of `mcp-store.ts`. An older handler that
ignores the preflight hook fails the changed gate. Existing assertions are unchanged.

## Existing Hosted event and child scenarios through native Codex

`run-hosted-native.mjs` freezes the existing Hosted automation SQL suite and wraps
its deterministic step oracle with `oracle-native.mjs`: actual installed contained
Codex, private synthetic login broker, Responses SSE, HTTP/SDK and SQL. The original
model/provider decisions stay controlled. Async-local occurrence context keeps
parent and child requests separate. No live credentials or provider calls are used.

Use the same prerequisites/environment as above, substituting this launcher:

```sh
node apps/f1/native-context-join/run-hosted-native.mjs \
  /absolute/hosted-checkout FULL_HOSTED_SHA \
  /absolute/isolated-installed-prefix FULL_RUNTIME_SHA /absolute/new-evidence
```

Default modes: `read-set-direct-child,read-set-ticket-child,linear-events,slack-channel-events`.
`CYRUS_NATIVE_JOIN_MODES` may narrow this list. All four are required for the full
report. The frozen fixture enables event session delivery, explicit DB preflight,
and Codex target metadata. Strict source seams fail when upstream changes require
review. Original and adapted driver/test sources and input hashes are preserved.

Database and contained processes are cleaned up by the existing fixture. The frozen
source and private synthetic fixture directories are retained for inspection;
remove only those paths after reviewing a failure. No registered live instance is
started. The evidence directory must be new.

This gate proves queued next-occurrence events and both child session lifecycles
with ordered timeline receipts. It still manually delivers prepared outbox rows;
it does not establish signed ingress, production wake/dispatch, parent successor
consumption, live ticket assignment or UI reload. Keep those gaps explicit.

## Native rejected-write correction

`CYRUS_NATIVE_JOIN_TOOL_REJECTION=1` requires `CYRUS_NATIVE_JOIN_COMBINED=1`
and Hosted containing the immutable native rejection migration/helper (c6885f6a
or successor). The fixture uses production `checkNativeResult` for source-plan
and direct invoke results; it does not classify SQL exceptions itself.

One new source occurrence deliberately invents an evidence reference, loses the
committed rejection ACK, recovers the same operation key, and corrects the call.
The combined occurrence separately mistakes an actual issued issue reference for
input evidence, receives a denied result and corrects it in the same attempt.
SQL must contain two immutable rejection receipts and one corrected fact per
occurrence. The 47-second model delay/renewal, source text, crossed-reference,
withdrawal and terminal lost-result assertions remain. All normal references retain
the model-input assertion; only the additional deliberately forged negative input
is asserted absent instead.

The first installed39781300 / Hostedc6885f6a run blocked at read_messages because
Hosted introduced undeclared author/time siblings into the strict `{reference,text}`
result. That failed evidence remains preserved. The same committed b73d3b3c driver
and installed39781300 **pass** against Hosted
`a65f265730cbb6147588d3cf6e3437d5e13aa4be`, which places bounded provenance inside
the existing text field. Runtime validation and the installation are unchanged.
The passed gate includes 11 completed occurrences, 26 model exchanges, two immutable
negative receipts and one SDK session across three combined-source renewals.

The separate [engineering-to-parent recipe](../../../docs/engineering-parent-acceptance.md)
identifies the remaining production dispatcher/native parent successor gate. It is
preparation, not evidence that this context join exercises that path.
