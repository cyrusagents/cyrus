# Ordinary native memory/work and retired approval safety

Date: 2026-10-01. Increment from `6ce464738323806743c510da7107ca563bbb80f5`.
F1 applies because the executable catalog, context projection and recovery of
historical tool intents change. The native image remains
`sha256:35ffa8e695666695f047cf527138b9b27f2e1c29d44673f9eb705a0e4010be4f`.

Source native F1 passed using `nativeContextOnly:true,sessionDeliveryAuthority:true`
from [the contract recipe](../../../docs/runtime-native-context-v1.md): four
completed occurrences, seven native model exchanges, three memory/work writes,
41 ordered session deliveries. Memory lost-ACK reconciliation preserves one effect
and its write identity, starts a fresh native transcript, and retrieves the fact
in a later occurrence. Work create/update still succeeds. The native catalog has
exactly `read_context`, `remember_context`, `track_work`; no approval tool.

Focused native-context, MCP, recovery and session-delivery regressions: **28 passed**.
Legacy envelope/receipt parsing remains compatible. New recovery coverage loads an
old pending approval intent and verifies zero tool writes, zero additional model
opens, no false result, and unchanged saved operation key. Terminal receipt-only
recovery with legacy permissions still succeeds without model/context reopening.
No historical pending action is applied automatically.

The new [installed SQL/HTTP/native driver](../native-context-join/README.md) joins
actual Hosted handlers and migrations in a disposable local database. Earlier exact
installed `6ce46473` + Hosted `24a4b7e0` direct-path evidence passed eight completed
occurrences, twelve model exchanges and 65 deliveries: memory later recall, work
proof/linkage, source-derived memory exclusion after withdrawal and terminal ACK
recovery after policy change. It deliberately excluded the write-ACK fault and is
not full recovery acceptance. Enabling that fault exposed Hosted SQL rejection
`Native session identity changed` on lifecycle sequence 12 after authorized fresh
native recovery. Runtime retained ordered delivery barriers and refused final
result. Hosted correction and an exact successor join are required.

The source F1 uses controlled Hosted/model transports. The joined fixture uses real
Hosted SQL/MCP/session handlers but synthetic provider checks, outbox inputs and
proof production. Neither is live model/provider, UI or dispatcher acceptance.
Immutable artifact/installed repetition and subsequent joint evidence are recorded
with the candidate handoff. No live runtime/customer state was changed.
