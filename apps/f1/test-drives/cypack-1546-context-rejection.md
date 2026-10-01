# CYPACK-1546 — repair a rejected native context write

Source/artifact: `397813003cccc9e1f936feff3e96987e1b507229`.
Parent: `2419f3d3a430346b131dc18bc25a50aa5586d734`.
Hosted ACK: `163d6f45-d16a-44e6-bf82-23f76766af10`; contract in
[registered native context](../../../docs/runtime-native-context-v1.md).

The observed live failure supplied an issue reference to `evidence_reference`;
generic MCP failure kept that invalid write pending and repeated it. This change
only recognizes an authenticated, strict, operation-bound no-effect rejection for
`remember_context`/`track_work`. It returns fixed corrective guidance and checkpoints
the result. Unknown failures and uncertain writes retain the original pending key.
It does not reset or replay the existing blocked live occurrence.

## Focused checks

24 tests passed across native context, context recovery, SDK renewal, combined
sources and Slack channel access. The new SDK regression failed before the patch
with `Scoped MCP operation interrupted`, then passed. It checks all three declared
rejection codes, wrong key/version/effect/code/extra fields/oversize denials, raw
error text suppression, lost rejection ACK retry and existing applied-write lost
ACK reconciliation. Native rejection markers cannot resolve publication, provider
writes, delegation or context reads. Build, typecheck and lint hooks passed.

## Native drive

The existing `runAutomationDrive({nativeContextOnly:true})` now adds one occurrence:
invalid evidence reference -> native model receives denied/code/guidance -> model
corrects the arguments -> exactly one fact stored -> completed on attempt 1.
Private checkpoint retains denied then applied hints, sequence 2, and only its
immutable terminal result intent. No raw rejection detail reaches the model.

Source and exact installed drives passed: 5 completed occurrences, 10 native model exchanges, 4 applied
writes, 1 rejected write, 52 session delivery calls. Existing lost write ACK, fresh
native transcript/context after recovery, future retrieval and work create/update
remain in this same drive. The first run exposed a new fixture assertion wrongly
expecting terminal pending data to be deleted; the corrected assertion requires
the durable final-result receipt and no pending tool. Both logs are retained.

Registered runtime HTTP, SQLite/checkpoints, MCP SDK and isolated native Docker
are real. Gateway policy/provider/model responses are controlled. This is not
Hosted SQL rejection-receipt proof, live customer acceptance or latency improvement.

## Reproduce

Use the exact reviewed preloaded image
`sha256:35ffa8e695666695f047cf527138b9b27f2e1c29d44673f9eb705a0e4010be4f`
and an authorized disposable Docker socket. No network/mounts/pull in the container.

```sh
CYRUS_F1_CODEX_IMAGE=sha256:35ffa8e695666695f047cf527138b9b27f2e1c29d44673f9eb705a0e4010be4f \
node --input-type=module -e 'const {runAutomationDrive}=await import("./apps/f1/automation-drive.mjs"); console.log(JSON.stringify(await runAutomationDrive({nativeContextOnly:true})));'
```

Bundle SHA256: `db63952ef67a855c71295eb07a268e90b17902735062e5af6d78737447335aa8`.
All 17 packages and 17 resolved installed copies verified; CLI version smoke passed.
Exact-head Node22/24 CI36821814870/36821821741 green.

Artifact and installed evidence are under
`/Users/agentops/.cyrus/CYPACK-1546/attachments/context-rejection-39781300/`.
The installed driver differs only in import roots; invoke its exported function
explicitly. Build source using `scripts/build-local-artifact.mjs`; verify all
17 installed copies with `scripts/verify-local-artifact.mjs`. No registry publication
or minimum published version is implied. Coordinator alone owns live installation.

## Actual Hosted join: preserved failure

Installed39781300 + published Hostedc6885f6a12c7229e2903852496dabc94f2b85286
with both combined/rejection flags progresses through ordinary memory/work and
source rejection lost-ACK recovery. That source occurrence returns its immutable
negative receipt twice under one key, corrects the write on attempt2, then source
read/withdrawal checks pass. It next blocks at combined read_messages sequence1.

Hosted84dd added timestamp/threadTimestamp/author alongside reference/text, while
the current runtime intentionally rejects undeclared fields. The full join is not
accepted. Hosted handoff6262ef8b requests bounded provenance within existing text
or explicit negotiation; runtime validation is unchanged. Logs and partial private
fixture are retained, and the new gate is committed for exact reproduction after
the counterpart correction. An earlier new-negative-case oracle assertion failed
before Hosted because it required the deliberately forged reference in model input;
only that added negative case was corrected, all prior positive assertions retained.

## Actual Hosted join: compatible counterpart passes

Hosted ACK `bf08d8c3-ac19-48b6-aa6e-3a05737bd4cc` published
`a65f265730cbb6147588d3cf6e3437d5e13aa4be`, restoring `{reference,text}` and
putting bounded author/time provenance inside text. The unchanged b73d3b3c driver
and installed39781300 passed the combined + tool-rejection gate in 93.66 seconds
(94.44 seconds including test startup). No runtime schema relaxation or rebuild.

Actual SQL/HTTP/SDK/native assertions: 11 completed occurrences, 26 model exchanges,
13 result transmissions and 121 session deliveries; two immutable rejection
receipts, with the lost rejection ACK replayed twice under one operation key.
The source write recovers on attempt2; the combined issue-reference mistake is
corrected on attempt1. The delayed combined read retains one MCP session through
three renewals, both source bodies and crossed-reference denials. Ordinary lost
write ACK, evidence-linked verified work, mixed-source withdrawal, fresh survivor
context and terminal receipt-only recovery after policy change remain passing.

Evidence: `context-rejection-39781300/joined-a65f2657/joined-summary.json` and
`joined-a65f2657.log` in the issue attachments directory. Driver provenance remains
`b73d3b3c91125987d15cca70fb8bf0c0cabe1aa2`; later documentation changes do not
alter the executable fixture. Controlled provider/model checks and prepared outbox
limitations still apply. This does not establish live responsiveness or the
production dispatcher/parent successor path.
