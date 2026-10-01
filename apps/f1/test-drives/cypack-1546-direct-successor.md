# Native direct child through production parent dispatch

Frozen Hosted `8995bb5a2534b83b60ab00362e94f1cdd92dc9c8`, installed Runtime
`d66ed0a86d0d925fe88469a142da93f640aee416`. No new executable or test bundle:
this patch extends the existing native child launcher and its assertions.
F1 applies to this functional harness change.

**87 tests /933 assertions PASS,25.76s**. Three completed occurrences (original
parent, isolated child, fresh parent successor),9 actual native model requests,
3 native opens/closes,4 result transmissions including the original lost ACK.
[Bounded summary](evidence/cypack-1546-direct-successor.json).

The existing direct-child scenario remains intact. The extension gives its
original admitted operator input a real synthetic work thread and explicit
no-memory/no-work-change/no-external-write restrictions. The child returns a
synthetic finding plus a contrary save/post suggestion. The actual Hosted result
handler/SQL emits the internal event. The extension calls the production
`deliverCustomerAutomations`; it never constructs or inserts the successor outbox.
The registered route receives that persisted dispatch on the same installed
runtime/ledger. Three dispatcher calls (including a duplicate before completion)
produce one successor outbox and one linked reply.

The successor negotiates native context through the actual callback/SQL, performs
one fresh read_context, and starts a new contained native turn. Assertions check
originalInput byte-for-byte, original parent session and revision, work identity,
child findings, the entire assembled prompt, and the entire prompt again on the
actual native provider request. The deterministic model emits only the summary.
Final SQL assertions verify the original work-thread reply, zero facts, zero
native writes and zero Slack reply effects. Original isolation, scoped reads,
ordered activities, lost-ACK and SQL stale/foreign/revision checks remain.

Boundaries: the initial/child outbox delivery, model/provider transport, registered
transport/credential resolution and scheduler wake trigger remain controlled.
Production successor dispatch, admission, SQL, HTTP, SDK, native container and
receipt paths are actual. This proves instruction delivery, not live-model
obedience, signed ingress or responsiveness. No live runtime/home/customer state
was read or changed. Ticket-backed lifecycle retains separate native/SQL coverage;
this new production successor extension selects the direct case only.

## Reproduction

Use the unchanged17-package d66 bundle and approved image from
`attachments/async-child-d66ed0a8/HANDOFF.md`, then:

```sh
CYRUS_TEST_DOCKER_PATH=/usr/local/bin/docker \
CYRUS_TEST_DOCKER_HOST=unix:///var/run/docker.sock \
CYRUS_F1_CODEX_IMAGE=sha256:35ffa8e695666695f047cf527138b9b27f2e1c29d44673f9eb705a0e4010be4f \
CYRUS_NATIVE_JOIN_PARENT_SUCCESSOR=1 \
CYRUS_NATIVE_JOIN_MODES=read-set-direct-child \
node apps/f1/native-context-join/run-hosted-native.mjs HOSTED_CHECKOUT \
  8995bb5a2534b83b60ab00362e94f1cdd92dc9c8 INSTALLED_PREFIX \
  d66ed0a86d0d925fe88469a142da93f640aee416 NEW_EVIDENCE_DIRECTORY
```

The launcher freezes Hosted source, preserves original/adapted files and hashes
all helper sources. Local evidence: CYPACK attachments/direct-successor-8995-d66-r3.
Two earlier attempts are preserved: a new observer mistakenly treated an authority
getter as an object, so its expected context was undefined. The saved synthetic
native transcript already contained the full correct prompt. Correcting the
fixture getter produced this pass; no Runtime/Hosted authority fix was made.

## Protocol review

This join explicitly enables server-owned `current-sql-v1`; full scoped catalog
and tool checks remain. Frozen Hosted protocol suite independently passes7/68.
[The contract review](../../../docs/mcp-protocol-admission.md#exact8995-review)
records remaining GET/notification/fallback negative-branch gaps handed to Hosted.
No live performance claim follows from these controlled timings.


## Independent replay diagnostic follow-up

The coordinator's frozen 6315/d66/8995 replay failed with 86 passes and one failure:
its child-result outbox was not marked delivered. The old assertion did not expose
whether production dispatch rejected a request or skipped a not-yet-due row.
The fixture now retains up to 64 fixed transport/ACK and SQL error-code records,
and reports attempt count, relative next-attempt time, database clock offset and
whether the binding recorded an error. It does not record credentials, request
bodies or provider content. Dispatch semantics and all existing assertions are unchanged.

Author replay of the diagnostic driver with the same installed d66 and frozen
Hosted 8995 passed 87 tests / 933 assertions (25.80s). Evidence is in
`/Users/agentops/.cyrus/CYPACK-1546/attachments/successor-diagnostics-8995`.
This does **not** explain or supersede the independent failure; that environment
needs the diagnostic replay before a cause or correction can be claimed.
