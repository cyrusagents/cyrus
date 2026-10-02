# Registered native context, work and approval continuation

Historical evidence for `6ce464738323806743c510da7107ca563bbb80f5`. Connor's
subsequent pending-approval removal supersedes its positive approval scenario.
See [ordinary memory/work validation](cypack-1546-native-direct.md) for the current
capability; this report is preserved without upgrading its original claims.

Date: 2026-10-01. Changed behavior: negotiated native context through the existing
registered runtime, including source-free memory, current-context recovery and
strict work/action tools. F1 is required for these execution/recovery changes.

Run the `nativeContextOnly:true, sessionDeliveryAuthority:true` variant documented
in [the contract](../../../docs/runtime-native-context-v1.md). Native process image:
`sha256:35ffa8e695666695f047cf527138b9b27f2e1c29d44673f9eb705a0e4010be4f`.
The disposable drive uses production registered HTTP routes, SQLite scheduling,
checkpoint storage, real MCP SDK sessions, contained native Codex/Docker, normalized
activities and ordered receipt delivery. Hosted policy/storage and model responses
are controlled fixtures; no live customer or external provider is contacted.

## Assertions and observed result

PASS, six completed occurrences and one interrupted/recovered attempt:

- A source-free coordinator receives only `read_context`, `remember_context`,
  `apply_approved_action` and `track_work`, with no model-selected authority fields.
- A model memory write commits, then the fixture deliberately loses its ACK.
  The private pending intent remains durable. After stopping/recreating only the
  disposable runtime and letting normal retry delay pass, the same key reconciles
  one write. The fixture expires only its own remote owner; no ledger/checkpoint edit.
- The recovered model gets a new native identity and current context; the old private
  marker in its previous rollout is absent. The saved pending write key is unchanged.
- A distinct later occurrence retrieves the remembered fact before model execution.
- Native tool calls create a work item, then a later occurrence receives a current
  work reference and marks it waiting. Model references are asserted present in the
  received context; arbitrary thread/proof IDs are unavailable.
- Approval policy returns pending without saving the proposed fact. A fixture operator
  approves that exact proposal and a separate successor occurrence applies the
  current approved reference. One fact is stored; the proposing run is not reopened.
- Ordered session receipts precede every committed result.

Observed counters: 59 session deliveries, 7 MCP initializations, 110 catalog reads,
12 unique tool operations, 11 native model requests, 7 progress sends, 6 result
transmissions/commits, 5 native write/proposal receipts. No fixture denial in this
positive workflow; denial coverage is separate, not inferred from zero.

Focused regression set: **125 passed, 3 opt-in skipped** across context, registered
runtime, MCP, read-set/channel, recovery/interruption/delivery, contained Codex and
engineering tests. Native-context cases use actual MCP transport for 125-fact
pagination, foreign scope/session/reference denial, strict arguments, proof denial,
lost write ACK, pending/applied/disabled policy and revocation. SQLite recovery cases
cover the native-intent/pending-checkpoint crash window and lost terminal ACK without
model/context reopening. Additional result checks cover optional metadata and UTF-8
page bounds. Production typecheck and changed-file lint passed.

## Limits

This report is runtime controlled proof. Actual Hosted SQL/HTTP plus installed native
joining, approval wake, provenance withdrawal, trusted outcome/confirmation and UI
reload visibility remain coordinated acceptance gates. The test cannot establish live
memory/work completion or provider integration. No published minimum version,
installation, runtime restart, live prompt, memory write or release is authorized by
this evidence. Immutable artifact provenance and installed repetition are supplied
separately with the candidate handoff.
