# CYPACK-1546: negotiated Slack channel reads

Date:2026-09-30. Source delta from589f23b3, committed with this report; exact
installable head and package hashes are recorded in the separate artifact handoff.

Changed behavior: registered automations may accept an explicitly negotiated
Slack channel read grant, distinct from a fixed thread grant. Only bounded channel
history and opaque-reference thread reads are admitted. Native Codex and Messages
receive descriptions of the granted tools; no provider/authority selectors or
credential/filesystem fallback are exposed. Channel writes are absent.

## Verification

Focused native drive uses the production registered HTTP entrypoint, private
SQLite ledger/checkpoints, real SDK initialize/list/call and immutable Docker
Codex. The controlled model first reads channel history, waits25seconds across
lease/token renewals, then uses the exact returned reference with read_thread.
Assertions require one MCP session, two reads, same-session renewal, one result
commit and first-attempt completion. Native model input must contain only
read_messages/read_thread and the no-fallback instruction. Messages uses the same
fixed argument/result contract.

```sh
CYRUS_TEST_DOCKER_HOST=unix:///YOUR_AUTHORIZED_SOCKET \
CYRUS_F1_CODEX_IMAGE=sha256:35ffa8e695666695f047cf527138b9b27f2e1c29d44673f9eb705a0e4010be4f \
node --input-type=module -e 'import {runAutomationDrive} from "./apps/f1/automation-drive.mjs"; console.log(JSON.stringify(await runAutomationDrive({slackChannelOnly:true}),null,2))'
```

Omit image for Messages. Both controlled drives pass:8 session renewals,1 MCP
initialize,2 tool reads and1 result commit. Native delivers10 activity/lifecycle
transmissions, Messages9 (both include an intentionally lost activity ACK).
The exact installed-package native drive is additionally required in artifact
verification; its evidence is kept with that bundle rather than inferred from source.

Focused regression tests cover absent negotiation, current authority revocation
while the model runs, strict forged extra fields, channel-write/worker escalation
denial, unchanged fixed-thread tools, result metadata isolation, foreign-session
references/cursors, invalid history results, absent catalog tools, renewal/reconnect,
and expired references/revocation reaching the actual SDK server before provider work.
Existing interruption/recovery/diagnostics tests remain passing:84 focused runtime
passes/1 opt-in skip;19 broker/native cleanup passes/2 opt-in skips.

The new exact-catalog assertion initially failed. Diagnostic capture showed native
Codex also supplied apply_patch/view_image/request_user_input; the broker had
forwarded these known local built-ins. The fix strips them from the provider-visible
catalog while preserving existing rejection of unknown tools and all authorization
checks. Explicit native developer instructions prohibit fallback. Corrected native
F1 verifies both policy text and the exact two admitted Slack tools. Earlier failed
assertion/timing logs are preserved in the artifact evidence, not claimed as passes.

All Hosted/Slack/model HTTP providers are controlled fixtures; Docker/native
process/SDK/runtime/ledger are real. No live Slack membership, Connect eligibility,
provider-account, hostedSQL or customer acceptance is claimed. Those remain
Hosted/verifier-owned. No live runtime/home/settings or prior589artifact changed.
Test runtimes and containers close through their normal cleanup paths; disposable
checkpoint evidence is retained under the emitted /tmp directory.
