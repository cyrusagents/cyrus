# CYPACK-1546: negotiated owner interruption

Date: 2026-09-30. Source: 31f3ee1b83650927748ba1af40159545a1eca477 plus
this commit's interruption/cleanup changes. Hosted accepted the optional contract
in runtime-thread ACK77030f57; this report does not claim connected Hosted SQL proof.

## Runtime and native proof

The existing registered HTTP/SQLite/MCP SDK drive supports the focused selector:

```sh
CYRUS_TEST_DOCKER_HOST=unix:///var/run/docker.sock \
CYRUS_F1_CODEX_IMAGE=sha256:35ffa8e695666695f047cf527138b9b27f2e1c29d44673f9eb705a0e4010be4f \
node --input-type=module -e 'import {runAutomationDrive} from "./apps/f1/automation-drive.mjs"; console.log(JSON.stringify(await runAutomationDrive({ownerInterruptionOnly:true,ownerInterruptionFault:"tool"}),null,2))'
```

`ownerInterruptionFault:"model"` injects a model failure after a completed read;
`"tool"` deliberately loses the tool ACK after the controlled provider receipt.
Omit the image for the contained Messages adapter. All model/provider/Hosted
HTTP transports are synthetic; external network is denied.

PASS: Messages and actual isolated native Codex recover after model interruption.
Two identical interrupt transmissions reconcile one release receipt after lost
ACK. Normal attempt 2 completes before the original owner lease expires; no
blocked-work reset, new input, widened grant or new tool operation identity.

PASS: native pending-tool case has `running` checkpoint, sequence 0, pending
operation and native session before release. The original native thread and
pending key survive reconnect; two tool transmissions reconcile one controlled
effect. Two interruption transmissions reconcile one release, and one final
result commits. Actual SDK initializes twice; native model is invoked twice.
The verifier's safe live8007 metadata has the same checkpoint shape, but its
original failure category remains unknown. Missing terminal native event is
not proof of model timeout.

Focused runtime regressions: 78 pass / 1 opt-in skip. Cleanup fault tests: 6 pass /
2 real-image opt-in skips (actual native execution covered by F1 above). Additional
SDK cleanup tests: 12 pass including runtime interruption tests. Assertions cover
model/tool cleanup failure retaining ownership, waiting for activity delivery,
terminal and legacy exclusion, malformed/foreign ACK rejection, bounded uncertain
ACK retry, unchanged retry budget/input/checkpoint/write keys, container absence
proof after failed `rm`, and waiting for in-flight supervisor callbacks.

An initial broad drive placed the new scenario after its intentional runtime
shutdown and timed out with the new occurrence still unclaimed. The harness
ordering was corrected; targeted runs above exercise the relevant live registered
entry point. That failed report is preserved separately; it is not a runtime
recovery failure or a passing broad-drive claim.

No live runtime/home/checkpoint, real provider/model or customer was modified.
Hosted owns atomic exact-owner revocation and receipt replay across replacement
owners; its connected SQL/HTTP tests and installed-artifact joint gate remain
separate. No registry release, merge or deployment.
