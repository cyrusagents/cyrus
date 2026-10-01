# One-way customer submission and private registered PM drives

Run after `pnpm build`, using Node 24+ with `node:sqlite` support. All state lives
in owned temporary directories. No paired workspace, actual login or provider
credentials are used; neither drive touches an existing runtime. The PM drive
uses the production normal CodexRunner and subprocess transport with a controlled
app-server. The customer drive uses the actual contained native Codex image and
real MCP SDK HTTP, with a controlled provider responder.

```sh
node apps/f1/trusted-pm/drive.mjs
CYRUS_F1_CODEX_IMAGE=sha256:35ffa8e695666695f047cf527138b9b27f2e1c29d44673f9eb705a0e4010be4f \
  node apps/f1/trusted-pm/customer-native.mjs
```

The customer drive requires the reviewed image already loaded; no pull, network
or filesystem mounts are enabled in its container. Optional
`CYRUS_TEST_DOCKER_PATH` and `CYRUS_TEST_DOCKER_HOST` select an authorized local
Docker binary/socket. Do not point at another user's daemon.

For exact installed artifacts set both `CYRUS_F1_EDGE_DIST` and
`CYRUS_F1_CODEX_DIST` to the isolated installation's package `dist` directories.
`CYRUS_F1_OUTPUT=/absolute/summary.json` records credential-free assertions.
Manifest source SHA/17-package provenance must be verified independently before
an installed claim. Retain the exact driver commit alongside the package SHA.

Assertions include current PM admission and queued-start fencing; normal tool
start/result/final normalization; private ordered activities; exactly one result
through ACK loss and repository withdrawal; active PM revocation with no result;
restricted vs verified email issue projections; no contained PM/full-repository
or direct-delegation tools; a referenced one-way submission through ACK loss and
fresh native transcript; terminal receipt recovery after policy epoch change.

These are controlled Hosted/provider fixtures. Actual published Hosted SQL,
production outbox dispatch and private UI authorization must be joined separately.
No live PM/model/provider or customer UI acceptance is implied.
