# Installed runtime: current owning-team gate

Passed October 2, 2026 against these immutable inputs:

- Runtime executable: `23811dfadc78bf12549319435c4f94a81b79705b`.
- Runtime F1 driver: `058d7cb656183acc7ac08ef2a47ac17361d9b639`.
- Hosted SQL/HTTP/MCP: `131712e0f21e16dff68ced02b80876aa78ae882c`.
- Image: `sha256:35ffa8e695666695f047cf527138b9b27f2e1c29d44673f9eb705a0e4010be4f`.
- Disposable 17-package bundle SHA256: `146ada92548ef47774a961c45e0fa900795312e95c087c8dcdf28d8a03e30c12`.

## Results

The real registered HTTP/SQLite runtime, MCP SDK and native Docker process ran
against frozen Hosted handlers and migrated disposable PostgreSQL. The model and
provider transports and source outbox construction were controlled fixtures.
The run passed in 54.83 seconds. Numeric evidence is in the adjacent JSON file.

Instruction and source-event work were durably queued while the owning team's
`is_admin_team` was true, then execution was released after it became false.
Both blocked after three bounded attempts. A stale scheduled definition produced
a real local tick which also blocked after three attempts. All three created
zero customer admissions and opened zero models. The event was prepared before
withdrawal because the new Hosted outbox guard also correctly rejects new inserts
while OFF; the fixture does not bypass that guard.

Withdrawal immediately after a successful admission caused the next current MCP
check to deny before model opening. That occurrence blocked without executing a
model or tool. The fixture observed 13 total boundary denials.

A separate ON occurrence executed one native model step and one `read_context`.
Hosted committed its result, deliberately lost the ACK, and withdrew eligibility.
The runtime recovered the exact pending result on attempt/fence 2 while OFF:
**one model open, one model response, two result transmissions, one SQL commit**.
It did not reopen the model or execute a write tool. The eight private activity
deliveries and original checkpoint/receipt identities were retained.

No Runtime production authorization changes were required. Eligibility remains
Hosted-owned; generic definitions are not themselves execution authority.
The local test schedule was paused after its denial so subsequent positive cases
could not accidentally execute the next minute's tick.

## Reproduce

Install the exact disposable Runtime bundle into a private prefix and verify its
17-package source provenance. Preload the immutable image into your own approved
Docker daemon. With the matching Hosted checkout/dependencies and local fixture
PostgreSQL available:

```sh
CYRUS_NATIVE_JOIN_ROLLOUT_GATE=1 \
CYRUS_F1_CODEX_IMAGE=sha256:35ffa8e695666695f047cf527138b9b27f2e1c29d44673f9eb705a0e4010be4f \
CYRUS_TEST_DOCKER_PATH=/usr/local/bin/docker \
CYRUS_TEST_DOCKER_HOST=unix:///var/run/docker.sock \
node apps/f1/native-context-join/run.mjs \
  /path/to/cyrus-hosted 131712e0f21e16dff68ced02b80876aa78ae882c \
  /path/to/private-installed-prefix 23811dfadc78bf12549319435c4f94a81b79705b \
  /path/to/new-evidence-directory
```

Use your own approved socket/binary paths; no daemon permission changes or image
pull are part of the test. The driver archives the exact Hosted commit and does
not edit the Hosted checkout. Existing evidence directories are not overwritten.

## Limits and remaining release conditions

This is not live signed ingress, a production team activation, or an installed
trusted-PM gate test. Hosted separately tests PM HTTP/SQL gate denial and receipt
semantics; the installed normal PM F1 passed its existing revocation/recovery
cases. An installed PM scenario withdrawing this exact team marker remains a
separate evidence gap. In-flight ordinary PM provider operations are not claimed
to be synchronously retractable.

The bundle is unpublished test evidence. Canonical OIDC npm publication remains
held on the unpatched node-forge advisory and coordinator review. No customer
messages, live runtime changes, schedule resumes or real flag changes occurred.
