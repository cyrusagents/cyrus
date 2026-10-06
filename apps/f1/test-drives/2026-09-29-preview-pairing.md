# Controlled preview pairing and registered-runtime discovery

Scope: CYPACK-1546 pairing correction following the registered-automation
milestone `e28e3df1fda8fe2ef3d16d6077dc96ca0b554eaf`. This report ships with the
correction; the artifact handoff identifies its exact immutable source/hash.

Command: `pnpm build && /usr/local/bin/node apps/f1/preview-pairing-drive.mjs`
(Node22.17.1). The script writes a credential-free summary path on completion.
The author run passed at `/tmp/cyrus-preview-pairing-f1-uppx1u/summary.json`.

The drive exercises real AuthCommand → ConfigApiClient → StartCommand →
registerConfiguredAutomations → actual HTTP capability route/onReady/onClose.
An HTTP fixture supplies synthetic pairing credentials; the application worker
bridge registers the production automation service without launching a tunnel.
All unexpected transport is rejected. There is no live account or provider call.

Verified one auth request/one launch, Authorization-only auth with no query code,
redirect refusal, preserved launch preview origin despite an old stored origin,
persisted preview origin, mode0600 credentials, no fixture credentials in logs,
existing workspace identity, scoped capability discovery and unauthenticated401.
The returned model is the fixture contained Claude Messages adapter;
engineering/nativeTools/sharedMemory remain false. No published minimum version.

Related checks: cloudflare client8 tests; CLI163 tests; edge worker909 passed,
6 skipped. Eighteen focused session regressions cover Codex/OpenCode normalization,
new direct/ticket-associated Cyrus destinations, parent-result linkage after
serialization, sink rebinding denial and existing Linear/stop/concurrent paths.

The new session sink foundation is not a completed durable hosted adapter.
Session/delegation F1 acceptance remains open until the shared wire is accepted,
hosted persistence/auth/UI are wired and a real Codex run survives reload/reconnect.
The session unit replay is not a live harness run, assigned-ticket ingress proof,
scoped child execution proof or durable hosted receipt proof. Existing automation
F1 remains historical evidence for its separately documented scenarios.

Live preview pairing is coordinator-owned. Hosted auth-prefix logging must be
removed before the credential-free pairing gate passes. See
[pairing handoff](../../../docs/preview-runtime-pairing.md) and
[shared session dependency](../../../docs/session-activity-persistence.md).
