# CYPACK-1546 explicit operator recovery F1

This slice adds the supervisor-only registered POST /api/automations/v1/retry
command and operatorRecovery capability. See the exact contract in
`docs/runtime-automations-v1.md`. No live preview command was invoked.

[Messages](evidence/operator-recovery/messages.json) and
[native Docker/Codex](evidence/operator-recovery/native.json) drives pass:

1. Original occurrence exhausts three authority-denied attempts with no model start.
2. Wrong authentication, undeclared input, cross-workspace/occurrence, stale revision
   and stale fence are rejected by the actual registered HTTP entry point.
3. One explicit command receives202; an exact replay returns the identical receipt.
   Another command against that active cycle is rejected.
4. Current authority remains revoked, so all three cycle claims fail before model
   access. Original occurrence blocks at lifetime attempt/fence6. Replaying the
   accepted command still cannot reset its budget.
5. After fixture authority restoration, a new explicit command with expectedFence6
   recovers that same occurrence. It completes at attempt/fence7 with original
   input, ID, revision, order and scheduledAt unchanged. A new command against
   completed work denies; original receipt replay remains idempotent.

Existing read-set renewal/re-list, direct/ticket delegation, instruction/tick/event,
private checkpoints, session delivery and result ACK recovery remain covered.
Native drive additionally executes the immutable Codex app-server image, isolated
engineering test failure/repair/rerun and publication reconciliation. Models,
providers and Hosted authority are controlled transports, not live customer proof.

Reproduce after `pnpm build` (omit image for Messages-only):

```sh
CYRUS_F1_CODEX_IMAGE=sha256:35ffa8e695666695f047cf527138b9b27f2e1c29d44673f9eb705a0e4010be4f \
node --input-type=module -e 'const {runAutomationDrive}=await import("./apps/f1/automation-drive.mjs"); console.log(JSON.stringify(await runAutomationDrive(),null,2));'
```

Targeted tests also exercise two SQLite connections/restart, immutable command
replay after re-exhaustion, stale writers and fencing, same pending write payload
and operation key after revocation/recovery, changed checkpoint-scope rejection,
terminal receipt recovery with model unavailable, and a three-claim explicit
budget that does not reset during a terminal transition. Expired owners consume
the cycle budget; recovered scheduled ticks are not coalesced away.

The original live occurrence remains unchanged. Hosted owns customer/admin checks,
command persistence and eventual explicit invocation after independent review.
Acceptance of a command queues a bounded cycle; it never substitutes for current
Hosted admission/lease authority. No merge, release, production enablement or
live provider/model effects are claimed. Previous diagnostic/read-set evidence
is preserved; installed artifact proof is supplied with the exact-head handoff.
