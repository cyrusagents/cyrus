# Protocol-only MCP admission

Contract sent in comment1db26f26 and accepted by Hosted in9ce2548a on2026-10-01.
Exact server-owned opt-in: `protocolAdmission: "current-sql-v1"`, requiring preflight.
Published in Hosted8995bb5a2534b83b60ab00362e94f1cdd92dc9c8. The installed
d66 direct-child successor join exercises this mode; explicit negative-branch gaps
are recorded below. Baseline Hosted5429c3cad4aeff975f5c1c668fc0d48754b9c66c;
compatible installed Runtime75438a10deb245e172bf07b7435ad321d9b7fa7a.

## Boundary

Optimize only protocol framing which returns no customer data, tool catalog or
permission decision. Keep the existing `/mcp` SDK transport, pinned short-lived
Bearer credential, current session identity and JSON-only responses. A session ID
is not authentication. No new endpoint, runtime registration scope, token field,
model-visible parameter or positive authority cache is introduced.

The switch belongs to the server's `McpGateway` configuration, not an
HTTP header controlled by clients. Hosted must explicitly enable the exact mode;
without the exact supported mode and `preflight`, existing full checks remain.
Runtime does not infer authorization from an optimized initialization response:
its `connect()` still awaits a successful fresh full `tools/list` before returning.

| Request | Proposed current-admission path |
| --- | --- |
| Customer/native `initialize` | Fresh SQL before bounded body, fresh SQL after body, SDK protocol/schema validation, current-authorized atomic session open |
| Customer/native `notifications/initialized` | Fresh SQL before/after bounded body; exact admitted session and negotiated protocol; no data response |
| Customer/native optional GET | Fresh SQL credential/session/lease/revision/mapping check, then405; no SSE or provider response |
| Engineering, DELETE, unknown methods, absent/unsupported mode | Existing full checks |
| `tools/list`, `tools/call` | Existing preflight plus full current source/provider checks after body; no reduction |

Both SQL snapshots must describe the same admitted workspace/customer/run/attempt,
grant/session and protocol. A paused/revoked/expired/withdrawn or replaced owner is
denied. The post-body check cannot reuse the pre-body result. Opening the session
must check current authority atomically; a prior successful protocol message does
not permit later data access. The runtime never fabricates a local405, reuses a
completed authority decision or suppresses the SDK's actual request.

Token/session renewal remains serialized with runtime MCP operations and requires
the same server-admitted continuation. Source reference lifetime, immutable write
keys, result receipts, delivery ordering and reconciliation stay unchanged.
Unknown/expired references and stale/foreign tokens remain denied. A fresh token
does not make a foreign session or old execution current.

## Required affected verification

Hosted owns the implementation and handler/store negatives. Runtime owns joined
installed SDK/native proof using the existing fixtures, not a second server.

1. With the mode off or unknown, prove legacy full checks. With it on, real SDK
   initialize/notification/optional GET use current SQL and no provider reads;
   the initial catalog and each subsequent list/call retain fresh provider checks.
   Provider denial after a successful handshake must stop Runtime before execution.
2. Bad/missing Bearer, foreign session, wrong origin/protocol, malformed/oversized
   body, pause, lease/token expiry, stale owner/revision, source withdrawal and
   revocation are denied. Hold the body open, revoke, then complete it: the second
   SQL check must reject without opening a session or invoking a tool.
3. Engineering and DELETE retain full authorization. Unknown SDK methods cannot
   use the optimized branch to reach another resource/tool/sampling surface.
4. Preserve actual SDK same-session renewal during a delayed native response,
   old-token denial, cross-session reference rejection, both combined-source
   bindings and secondary withdrawal. Existing combined native join keeps its
   47-second delay, read assertions, rejection repair and immutable lost-ACK tests.
5. Preserve result-only recovery after policy change: no reopened model, MCP data
   access or duplicate effect; ordered durable activity ACKs still precede result.
6. Compare fixed phase counts from the exact before/after Hosted handlers using
   the same installed Runtime. Separate synthetic provider delays from actual
   SQL/native transport. Do not claim a live speed result from controlled timing.

## Runtime schedule and child boundaries

`AutomationLedger` remains the sole scheduler: exact slot/revision identities,
latest eligible offline tick coalescing, explicit FIFO inputs, no paused-time
catch-up, fenced bounded retries and durable resume. Investigator children cannot
forge a scheduled tick or coordinator role. The existing native launcher can run
`CYRUS_NATIVE_JOIN_MODES=instruction-tick` against the actual Hosted admission and
registered routes without adding another scheduler.

Child execution uses its admitted session/parent link and separate checkpoint;
session receipt flush precedes result. Hosted owns `automation.child.result`
routing into a new currently admitted parent occurrence. The original direct/ticket
native fixtures stop at their prepared outbox boundary. The optional
`child-successor-hosted.mjs` extension now invokes production dispatch and native
parent continuation, checking exact original restrictions and work-thread linkage;
the coordinator independently passed this at driverf19/Hosted71ed/installedd66.
This controlled step execution does not prove Workflow retry liveness. Coordinator
previously observed live754/5429 automatic direct-child return,
but the successor lost the original no-memory instruction and work-thread origin.
Hosted must carry exact initiating constraints through current successor admission;
Runtime preserves the supplied input and must not fetch another occurrence's
private checkpoint. Async tool guidance also clarifies that read_context is not
a child-status polling API. The complete live journey remains unaccepted.

## Exact8995 review

The real SDK protocol suite passes7tests/68assertions. It covers absent/unknown
mode fallback, full catalog provider denial after protocol success, revocation or
execution replacement while initialize body is held, engineering GET fallback,
unknown methods and DELETE full authorization. The direct successor native join
uses the new mode with real SQL snapshots and fresh native context. Existing SQL
SDK mutation/rotation/withdrawal tests use the mode but primarily assert list/call.

Missing explicit branch cases at this head (sent to Hosted in930f0a7d):
unauthenticated/expired/revoked/foreign-session optional GET; malformed/oversized
initialize with the mode on; revocation during held notifications/initialized;
engineering initialize/initialized fallback; supported mode without preflight.
GET returns no data and405 for valid admission; malformed protocol headers must
never turn it into a data/stream response. These are coverage gaps, not observed
authorization bypasses. The pre-body path checks auth/session; post-body protocol
uses a second SQL snapshot, catalog/call use full current authorization, and the
session open is still atomic. No cached permission decision was found in review.

## Follow-up coverage and production liveness

Hosted71ed adds the missing protocol branches above. Independent Runtime-owner
execution of frozen `19702b7de6f9b778cdd37e4fd273d109d0025a1c` passes the actual
SDK suite:11tests/288assertions. No Runtime negotiation change or new executable
is required. This is controlled HTTP/provider coverage, not a live revocation test.

Production liveness remains separate: at71ed/1970, the result callback awaits only
the durable Workflow start receipt. Both `deliveryStep` and
`conversationDeliveryStep` call the dispatcher once and return even when an
automation outbox is not yet due or receives a caught transport failure/backoff.
The Workflow retries Slack/Linear delivery, but lacks an automation-pending signal.
A second test-only drain does not establish a deployed successor wake. Hosted owns
the bounded retry in the existing Workflow, using current eligible outboxes and
unchanged occurrence/input/attempt budgets. Database-clock due selection removes
the precision race; transport/backoff also needs the existing workflow to retry.
