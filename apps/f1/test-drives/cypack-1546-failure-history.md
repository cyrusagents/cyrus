# CYPACK-1546: preserve original failure diagnostics

Date: 2026-09-30
Source: 024723ad7f2a4d38a059c55cbec6148dd899eb89 plus the failure-history change in this commit.

## Changed behavior and assertions

The existing controlled registered-automation drive now checks the authenticated
status endpoint after three admission denials. Each failure retains attempt,
fence, admission phase, HTTP status and timestamp. An explicit recovery exhausts
another three-attempt cycle without erasing the first failure; a subsequent
explicit recovery succeeds, clears lastFailure and retains diagnostic history.
Unauthorized status reads and widening/stale/completed recovery remain denied.

Command: `node apps/f1/automation-drive.mjs`
Result: PASS; 108 unique session receipts. Production runtime, SQLite ledger,
HTTP registration/recovery/status and MCP SDK transports exercised. Hosted,
provider and model responses were controlled fixtures; no live provider/model
calls, credentials or customer writes. No Docker/native changes in this patch,
so the Messages drive was selected for this ledger/gateway behavior.

Focused regressions also cover the first execution interruption followed by
owner-conflict denials, first-plus-latest-15 retention, stale-writer denial,
restart, explicit recovery and success. Full admitted prompt assertions cover
same-occurrence retry and separate later conversation occurrences. These prove
payload routing, not real-model response intent.

## Investigation limits

A separate controlled reproduction on installed 8a3 and source 024 demonstrates
that an injected interruption followed by 5/10-second retry delays can exhaust
the local budget while the modeled 90-second Hosted owner lease remains live.
Hosted independently confirmed the live occurrence's later denials were
`Occurrence already owned`. The original live interruption remains unknown.
No owner-lease rule, retry schedule or callback protocol is changed here.

Existing discarded errors cannot be reconstructed. The first recorded history
entry may be a later attempt after upgrade. These checks do not accept the
live greeting intent/latency, recover blocked live work, or replace Hosted UI
and actual-model acceptance. The live runtime was not modified.
