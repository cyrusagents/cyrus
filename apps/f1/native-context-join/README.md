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
