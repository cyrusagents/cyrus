# Contained native cold/warm startup profiling

Date: 2026-09-30. Baseline: `cc163642a5c7d63a32238d0a8f4c1885835c3f92`.
Candidate: this commit, one redundant broker preflight removed. PR1507 / CYPACK-1546.

The fixture uses the existing registered automation HTTP entry point, real SQLite,
private checkpoints and session journals, the actual SDK/native container and
Codex login broker. Hosted and model transports are controlled; no live prompts,
providers, workspace pairing or verifier runtime access. Each cold/warm pair uses
one runtime but two fresh isolated native containers. Cold means the first turn
in that runtime, with an already loaded image/running daemon; no cold VM claim.

Evidence and reproducible driver generator:
`/Users/agentops/.cyrus/CYPACK-1546/attachments/startup-profile-cc163642/`.
`create-profile.py` derives the driver from `apps/f1/automation-drive.mjs`, redirects
imports to the disposable installed packages, and wraps method/HTTP boundaries.
Only names, monotonic timestamps and stage relationships are recorded. No input,
model reasoning, credentials or raw checkpoint content is logged. `analyze.py`
produces disjoint pre-native interval accounting; overlapping spans must not be
summed. See HANDOFF.md in that directory for final numbers and artifact provenance.

The native image remains
`sha256:35ffa8e695666695f047cf527138b9b27f2e1c29d44673f9eb705a0e4010be4f`.
Run `runAutomationDrive()` exported by `profile.mjs` with this
`CYRUS_F1_CODEX_IMAGE` and an explicitly authorized `CYRUS_TEST_DOCKER_HOST`.
Use `STARTUP_HTTP_DELAY_MS=3500` for authority/delivery latency,
`STARTUP_PROVIDER_DELAY_MS=3500` for provider response headers,
`STARTUP_BODY_DELAY_MS=3500` for provider stream delay, or
`STARTUP_LOCK_DELAY_MS=500 STARTUP_POLL_MS=15000` for a disposable SQLite lock.
These injections are distinct cases, not production configuration options.

Assertions: two occurrences complete on attempt1, one native provider request per
turn, zero tool calls/MCP initialization, provider access only after native start,
ordered session receipts acknowledged before result, separate native containers.
The broker regression also denies a request cancelled during pre-send authorization
and suppresses provider output when authority is revoked while the response arrives.
The removed check surrounded only bounded synchronous input validation. Checks
before credential/provider access, auth recovery and response release remain.

Baseline observations: responsive gateway cold/warm pre-native 769/356ms; container
315/268ms. With 3500ms per Hosted HTTP request, pre-native 25856/25861ms and container
291/301ms. Warming does not remove serialized remote checks. A separate provider
3500ms delay produced 689/316ms pre-native and 3603/3605ms native duration.
Candidate controlled3500ms comparison passes: native-start-to-provider falls from
10558/10563ms to7049/7058ms, and native duration from14094/14082ms to10576/10585ms.
Pre-native remains26041/25862ms; the fix saves one broker round trip and does not
resolve the startup gate. These reproduce a mechanism, not the exact cause of historical live 44-second waits.
Full responsive-chat acceptance remains open. Matching Hosted request spans are
needed for historical attribution; this report does not label model time a bug.

No authority cache, lease relaxation, concurrent work reuse, changed operation
identity or reduced final receipt barrier. Initial/progress/session preflights
are unchanged; further reduction requires Hosted contract agreement. Broad
unchanged suites were not rerun for the one-check broker change.
