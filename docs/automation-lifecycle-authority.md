# Current action authority for customer lifecycle callbacks

Runtime proposal9d81addf and compatibility refinement186b0a20, accepted by Hosted
in d337006d on 2026-10-01. Hosted implemented the required callback admission-deadline
and current-grant checks at `4f9b7b26e51edde54969d6862bf83a48ddaa10ed`.
The [installed joined gate](../apps/f1/test-drives/cypack-1546-lifecycle-authority.md)
passes against that exact head; live installation and responsiveness acceptance
remain coordinator-owned.
The optional contract removes separate remote preflights only where the receiving
handler already checks current authority at the action itself. It never supplies
an authorization decision for another operation.

Runtime sends `X-Cyrus-Lifecycle-Authority: 1` on authorize, only alongside its
session-delivery negotiation. Hosted may return sibling
`lifecycleAuthority: "current-action-v1"` only for customer execution with
`sessionDeliveryAuthority: "current-admission-v1"` and session delivery enabled.
Runtime rejects the known mode without those session prerequisites. Unknown or
absent lifecycle mode keeps full preflight. Engineering always keeps full preflight.
The runtime capability descriptor advertises support with `lifecycleAuthority:true`
only when durable sessions are configured.

Under that exact mode:

- Progress reaches the existing authenticated handler with the same registered
  workspace/instance and exact occurrence/revision/attempt/fence. The handler must
  freshly check current lease, policy/pause/revision and owner before effect/ACK.
- After the model result has passed the unchanged fresh check and been durably
  checkpointed with its immutable operation key, the response and terminal session
  activities use their existing per-delivery current-admission authority. Runtime
  waits for every exact ordered receipt before calling result.
- Result reaches its existing authenticated current handler with the original
  tuple/key/payload. Normal completion still needs current authority; already
  committed results retain existing exact immutable receipt-only reconciliation
  semantics. The optimization does not create permission to execute after pause.
- Before each of these boundaries Runtime checks local scope, readiness/control,
  lease/credential deadlines and abort. It awaits any pending current check and
  performs normal remote renewal when expiry is within15seconds, then checks local
  authority again. Expired authority fails closed. No completed check is cached.

Initial admission/checkpoint access, periodic current checks, native/context/model
entry and exit, broker credential/provider request/response, every MCP invocation,
engineering, cleanup/interruption and pending-write recovery remain unchanged.
Callback errors, malformed activity ACKs or abort retain pending durable state and
normal bounded retry; they never manufacture a fresh operation identity.

New checkpoints pin the optional mode and reject a stored non-undefined mode that
changes or disappears during recovery. Renewal always pins the admitted mode.
Older checkpoints with no field remain on full preflight even if an upgraded
server now offers the optimization. Historical work is never retrofitted or
edited. This allows terminal lost-ACK recovery across an upgrade without weakening
its original barriers.

The affected tests hold final ACKs, revoke at actual progress/result boundaries,
expire or approach expiry during delivery, change modes during renewal/recovery,
recover the exact lost result ACK without reopening the model, and preserve the
engineering path. Controlled native profiling keeps both broker/snapshot checks,
actual SDK transport, two cold/warm native turns and final receipt ordering.
Exact installed evidence and Hosted implementation ACK are required for handoff;
controlled timing does not establish live responsiveness.
