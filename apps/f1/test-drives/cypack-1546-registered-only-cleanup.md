# Registered-only runtime cleanup — October 1, 2026

Executable and tested driver: `b14f6334dfa179a6863372ae3e2d537de42203d0`.
Previous PR head: `f4a5a4f7341c1b0b31bf3ffe3f58b864c82e2b5f`.
Initial service removal: `349b92075875654dd7031c80c6f45a3ade5278c8`.
PR1507 / CYPACK-1546. Existing branch and owners, no live changes.

## Removed and retained

Removed standalone command/server/config, scope/operation contract, global-key
model adapter, gateway, checkpoint store, runtime loop and public exports. Removed
special CLI env/Sentry branches, obsolete setup instructions, old executable F1
and old service tests. Removed the unused Bun selector: every current factory
already selected the reviewed Node image. Edge-worker build cleans `dist` before
compiling, preventing deleted modules from shipping from a reused checkout.

Retained `automations/DockerSandbox.ts`: current engineering readiness/factory and
runtime execute/snapshot/stop; same Node command/isolation semantics and snapshot
validator. Retained `utils/readBoundedJson.ts`: current automation gateway,
Messages adapter and durable session transport; byte-for-byte helper logic.
Registered checkpoint/ledger/authority/session/receipt schemas unchanged. No
exclusive npm dependency remained; Fastify/Zod/core still serve active callers.
See [current caller inventory](../../../docs/runtime-automations-v1.md#removed-standalone-prototype-october-1).

Historical reports remain; the September 28 standalone report is explicitly marked
historical. Current tests retain meaningful isolation and recovery assertions
against active components, rather than shipping an unused service to run tests.

## Verification

- 147 affected runtime tests passed, including registered engineering repair,
  retained edits, publication/result recovery, scope/fencing, SDK renewal and
  bounded JSON. Native image enabled, no opt-in skip in this run.
- 34 CLI/bootstrap and 12 durable session-delivery tests passed.
- Final selector cleanup: 25 native engineering tests passed again, including
  host credential/filesystem/network denial and timeout/abort/output-limit stop.
- Lint/build/typecheck hooks and exact executable Node22/24 CI passed.
- Fresh isolated bundle install: 17 packages/17 resolved copies match source.
- Actual CLI rejects the removed command; normal commands remain listed. Package
  import preserves registered entry and contains no removed exports or modules.
- Installed full native F1 passed: 143 unique activity receipts,
  149 deliveries, 19 result commits/20 transmissions,
  5 denials. One engineering publication despite two calls and lost ACK;
  initially failing test → retained edit/diagnostics → model repair → passing test.
  Instruction/tick, Slack/Linear admitted events, direct/ticket child delegation,
  durable session/result recovery, current-authority revocation and private
  checkpoints remain exercised through active HTTP/SQLite/SDK/native components.

Intermediate349 installed F1 also passed (19 commits/143 receipts); final b14
replay supersedes it for this cleanup. Both original evidence folders preserved.

## Reproduction and artifact

Bundle `cyrus-0.2.73-cypack1546.b14f6334dfa1-test-bundle.tar.gz` SHA256
`e749802dc3e5be0e2ebd22a2beab51bc2e5368eaf67d69ccafa11892148341ab`.
Credential-free artifact folder:
`/Users/agentops/.cyrus/CYPACK-1546/attachments/registered-only-b14f6334/`.
`HANDOFF.md` contains build/install/bin/image and exact replay; `VALIDATION.json`,
`installed-provenance.json`, `package-smoke.json`, `registered-native-f1.json`
and test logs retain evidence. Build from clean exact source using
`scripts/build-local-artifact.mjs`; no registry publication or minimum published version.

From exact source and a fresh isolated installed prefix, run the artifact's
`run-installed-smoke.mjs PREFIX FULL_SHA EVIDENCE_DIRECTORY` with
`CYRUS_F1_CODEX_IMAGE=sha256:35ffa8e695666695f047cf527138b9b27f2e1c29d44673f9eb705a0e4010be4f`
and authorized `CYRUS_TEST_DOCKER_PATH` / `CYRUS_TEST_DOCKER_HOST`. It adapts only
committed driver import roots to installed packages. No image pull/network/mounts.

Hosted test-only `customer-engineering-runtime-drive.mjs` must load
`DockerSandbox` from its existing `dist/automations` root; owner notified. Existing
standalone Hosted drivers refer only to their historical artifacts, not this API.

## Limits

Model/Hosted/provider transport and publication receipts in this drive are
controlled; Docker, native Codex, SDK, runtime HTTP, SQLite and activity handling
are real. This is not a live provider/UI or newly repeated actual Hosted SQL gate.
The prior exact01d/Hosted7346 join and independent E44 remain separately labeled.
Coordinator owns review/install/live acceptance. No live runtime, home, checkpoint,
provider, prompt or blocked-occurrence changes; no merge/release/deployment.
Broader latency remains deferred to CYHOST-1330 under Connor's cap.
