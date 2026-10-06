# Work proof rejection through installed native execution

This gate reproduces WORK-02 without touching its live occurrence. It uses the
installed Runtime `6a099aeeb3994251e0433c4b37b4eb8c633eaf3e`, the existing immutable
Codex container and frozen Hosted handlers/migrated SQL. Provider/model transport
and admitted input events are controlled. The changed F1 driver is opt-in through
`CYRUS_NATIVE_JOIN_WORK_REJECTION=1`; existing scenarios remain unchanged.

## Baseline reproduction

Frozen Hosted `76c9e952fc9a7fbf5657e33930047f13999e5a33` fails in 23.33 seconds.
The model reads current work, then requests `track_work` with the current work
reference, changed objective and `status: verified`, omitting `outcome_reference`.
The response is JSON-RPC error **-32600**, without an `isError` result or structured
no-effect receipt. Runtime disconnects and preserves the unresolved operation.
All three attempts fail with `mcp_operation`; the occurrence becomes blocked.
Its checkpoint remains running at sequence zero with the same pending verified
update and no result. This reproduces the live failure category; no exact live
SQL exception or private live checkpoint was collected by this test.

Hosted's existing wrapper only records `invalid_reference` for memory evidence.
The missing-work-proof error escapes through the generic MCP error path. Runtime
already accepts a bounded exact-operation rejection with `code: proof_required`;
a generic RPC error cannot establish that a write had no effect. Treating every
RPC error as a correctable no-op would break uncertain-write recovery.

Existing wire contract, unchanged:

```json
{
  "isError": true,
  "structuredContent": {
    "contractVersion": 1,
    "kind": "tool_rejection",
    "code": "proof_required",
    "effect": "none",
    "operationKey": "supervisor-supplied immutable operation identity"
  }
}
```

The receipt must be committed under current authority for the exact original
arguments before any effect. Lost acknowledgement replays that receipt with the
same operation identity. Only a corrected payload gets its distinct identity.
Unknown/extra fields, wrong key, oversized payload, authorization/transport errors
and unknown effects retain the fail-closed path. The canonical tool argument is
`outcome_reference`, not `proofReferences`.

The Runtime SDK test now exercises `proof_required` with `track_work` directly;
ten native-context tests pass, including invalid/malformed receipts and uncertain
writes. No executable change is required to recognize this existing code.

## Added joined assertions

Before the original positive proof-backed verification, the driver now performs:

1. Missing-proof terminal update returns a model-visible denial, leaves objective
   and status untouched, and the model corrects to `waiting` in the same attempt.
2. A separate missing-proof update loses its committed rejection ACK. Normal
   recovery retrieves the immutable receipt under the same key, starts a fresh
   contained transcript, and corrects to `waiting` on attempt two.
3. SQL contains exactly two negative receipts and only four successful work
   operations: creation, two corrected waiting updates, and the original later
   verification with an actually issued matching outcome reference.

With combined-source mode, a provider-bound coordinator also creates work, receives
the missing-proof rejection and corrects to waiting in one attempt. Its SQL ledger
contains one negative receipt and two successful work operations. This exercises
both source-free and provider-bound rejection paths. Each corrected occurrence
also persists one honest customer reply stating that work remains waiting; no
proof-free verification claim is accepted.

The existing positive proof fixture remains explicit: the harness inserts trusted
synthetic proof into its owned SQL fixture, then the model uses the reference from
`read_context`. It is not a claim that runtime can manufacture trusted proof from
objective prose or remembered context. Rejected updates never become verified.
The combined-source renewal/withdrawal, memory rejection and lost-ACK, receiver
Pause and terminal receipt tests remain available in the same drive.

Run from the immutable driver with the approved image and explicit same-user Docker
binary/socket:

```sh
CYRUS_NATIVE_JOIN_WORK_REJECTION=1 \
CYRUS_NATIVE_JOIN_TOOL_REJECTION=1 CYRUS_NATIVE_JOIN_COMBINED=1 \
CYRUS_NATIVE_JOIN_LIFECYCLE_AUTHORITY=1 \
CYRUS_F1_CODEX_IMAGE=sha256:35ffa8e695666695f047cf527138b9b27f2e1c29d44673f9eb705a0e4010be4f \
node apps/f1/native-context-join/run.mjs HOSTED_CHECKOUT HOSTED_SHA PREFIX \
  6a099aeeb3994251e0433c4b37b4eb8c633eaf3e NEW_OUTPUT
```

The bounded baseline used `CYRUS_NATIVE_JOIN_LOSE_WRITE_ACK=0` without combined or
memory-rejection flags, stopping at the first reproduced work failure. Preserved
red evidence: issue attachment `work-rejection-76c9-6a09-red/`, including protocol
categories, failure history, bounded checkpoint summary and exact helper hashes.

## Exact passing join

Driver `e1374c058766db5f932fc922b2fd79db6e162259`, installed unchanged6a09 and
published Hosted `107272ba0f71a339435a0e84677f6b504fefa99c` pass in **130.66 s**.
Fifteen occurrences complete; two receiver-pause cases intentionally block.
27 negotiated admissions, 209 checkpoint saves, 38 model exchanges, 180 activity
deliveries and 18 result transmissions retain the authority/recovery assertions.
Transmissions include lost ACK retries and a denied callback, not18committed results.

Three immutable proof rejections arrive across four transmissions. All three
corrected waiting operations have distinct keys and produce one honest reply each.
Ordinary source-free and provider-bound corrections finish on attempt one; lost
negative ACK recovers on attempt two. Matching proof still enables the original
later verification. The47s model wait, same-session renewal, source withdrawal,
memory/rejection recovery and terminal receipt reconciliation pass unchanged.

The first1072 run reached final evidence but failed its existing memory-rejection
count: it included the new provider-bound work receipt (three versus two). The
corrected driver filters that aggregate by remember_context while retaining exact
separate work-receipt/effect/reply counts. First-run evidence is preserved at
`work-rejection-1072-6a09/`; passing evidence, exact helper hashes, logs, unchanged
17/17 artifact provenance and replay instructions are in issue attachment
`work-rejection-1072-6a09-verified/HANDOFF.md`.

No Runtime executable or wire capability changed. Hosted changed its rejection
boundary under the existing contract; unknown effects remain uncertain. This is
controlled installed integration proof, not a live WORK-02 or latency acceptance
claim. Original5672/8007, live3456/4444 and customer state were untouched.
