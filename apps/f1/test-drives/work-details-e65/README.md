# E65 negotiated work waiting details

Runtime increment over 13d485fb; Hosted contract 98371685/c7c6da9c,
Runtime ACK 591b1c06. This drive is required because model-visible tools,
validated context and recovered native transcripts changed.

Actual contained Codex process, private SQLite/checkpoints, MCP SDK JSON HTTP
transport, broker and durable activity sink. Model/Hosted/provider authority is
controlled. This is not actual Hosted SQL, live customer or rollout acceptance.

```sh
CYRUS_F1_WORK_DETAILS=1 \
CYRUS_F1_CODEX_IMAGE=sha256:35ffa8e695666695f047cf527138b9b27f2e1c29d44673f9eb705a0e4010be4f \
CYRUS_TEST_DOCKER_PATH=/usr/local/bin/docker \
CYRUS_TEST_DOCKER_HOST=unix:///var/run/docker.sock \
CYRUS_F1_OUTPUT=/tmp/work-details-summary.json \
node apps/f1/trusted-pm/customer-native.mjs
```

Use only an authorized same-user Docker socket and the preloaded reviewed image;
no image pulls, host mounts or external providers. For an isolated installation,
set `CYRUS_F1_EDGE_DIST` and `CYRUS_F1_CODEX_DIST` to its respective package `dist`
directories. No registration or live runtime is involved.

Passed: four native model exchanges, two immutable work effects despite losing
the first write ACK, fresh transcript includes persisted waiting details, explicit
null clears reason/waiting-on while omitted next-action survives, one result
commit across two transmissions, 16 unique private activity receipts. Changed
policy epoch terminal recovery does not reopen the model. Tools' native schemas
include the negotiated fields. Source summary is adjacent.

The drive initially exposed a second legacy page parse in MCP cursor handling;
the client now consumes the cursor from the already validated negotiated result.
The existing default PM/disclosure mode remains available without the opt-in.
Focused unit/SDK and runtime tests cover legacy schemas, creation denial, bounds,
unknown versions/fields, worker denial, missing read fields, and renewal adding or
removing the acknowledgment. No work details imply a schedule or terminal proof.
