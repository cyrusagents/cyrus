# Bounded runtime stage diagnostics

Parent:16779d9023d614283940b4e2a00e0fd51a67a47f. Candidate:this commit.
Date:2026-09-30. Applies to registered runtime status and native lifecycle diagnostics.

Run the actual registered route, SQLite/checkpoints/session sink, contained Codex
image and broker with existing controlled gateway/model transports. Enable only
fixture latency diagnostics and negotiated delivery; two source-free turns, first
and warm runtime, each with a fresh isolated container. Inject40ms at each Hosted
request,80ms before provider headers,120ms into provider body consumption.

```
CYRUS_TEST_DOCKER_HOST=unix:///YOUR_AUTHORIZED_SOCKET \
CYRUS_F1_CODEX_IMAGE=sha256:35ffa8e695666695f047cf527138b9b27f2e1c29d44673f9eb705a0e4010be4f \
node --input-type=module -e 'const {runAutomationDrive}=await import("./apps/f1/automation-drive.mjs"); console.log(JSON.stringify(await runAutomationDrive({latencyOnly:true,sessionDeliveryAuthority:true}),null,2))'
```

Assertions: authenticated status contains each enumerated stage, provider-header and
body delays are measured separately inside the native turn, all delivery ACK spans
end before result, both attempts complete once, no tools invoked, stage count bounded,
no fixture credentials in diagnostic output, unauthenticated status denied401,
ordinary status responses exclude diagnostics even when collection is enabled.

Unit regressions separately cover concurrent trace isolation, failed-operation error
redaction, rejected untyped labels, span/record bounds, duplicate dispatch, latest
attempt replacement and unavailable diagnostics after restart. Existing delivery,
interruption, automation and broker/cleanup regressions remain passing.

Actual source native drive PASS:2attempt1 turns,2model requests,0tools,11delivery
transmissions,2result commits. The artifact handoff contains exact installed replay
and immutable source/hash. No claim of live Hosted SQL/model/provider proof, pure
model compute timing, historical44s attribution or corrected UI responsiveness.
Existing live3456/agentops4444 and runtime homes/checkpoints remain untouched.
