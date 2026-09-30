# CYPACK-1546: observed duration and intermediate delivery latency

2026-09-30. Candidate diff from reviewed baseline
`8a3b9b780428983764372fcfed695e3726552407`; source and evidence are committed
together. This is a bounded runtime correction, not new live acceptance.

The verifier's sanitized live evidence records scheduling at 17:47:33.094Z,
native task start at 17:48:24.924Z and completion at 17:50:58.658Z
(native duration 153735 ms; native first-token latency 19177 ms). UI says 23 seconds.
The 51.830-second scheduling-to-native gap has no per-stage observations in that
file. It cannot identify how much was queue, admission, remote authority/session
ACK, container startup or native initialization. Requested safe receipt timestamps
from Hosted in its existing session thread; no live checkpoint/credential access.

The existing counter sums monotonic model/tool invocation intervals, including
provider/broker response waits, tool waits, native initialization and local work
inside those calls. It excludes explicit blocking supervisor authorization, native
identity delivery, queue/backoff/offline and between-step delivery/progress/receipt
waits. Native task wall duration instead includes waiting for supervisor tool replies.
The login broker buffers bounded SSE responses before returning them, so native
first-token latency is not pure upstream first-token latency either. These are
intentionally different metrics. The supplied evidence does **not** establish an
exact decomposition of the live run or that every missing second was delivery.

Hosted handoff: retain `executionDurationMs`/`executionDurationComplete` and label
as **Observed execution**, explaining the exclusions. Complete means complete
measurement coverage, not native wall duration. No schema change, timestamp-derived
backfill or reinterpretation of historical values. See the committed v1 contract.

An avoidable runtime delay is fixed: intermediate activity/lifecycle appends are
locally durable, then one bounded ordered background drain performs current-authority
delivery. Their remote ACKs no longer serialize model/tool execution. Creation ACK
still gates session admission; terminal flush still gates `/result`. A failed
background ACK is retried by final flush with the identical immutable receipt and
fresh authority. Abort settles delivery before journal close; pending receipts
survive for authorized recovery. Other sink callers retain eager delivery.

Validation:

- Focused runtime/duration/outbox/schema: **88 passed, 1 opt-in skipped**.
- Before the production change, the delayed-ACK regression observed zero model
  calls while the ACK was held; afterward both model steps and the tool completed.
- Fake monotonic fixture: 230 ms measured versus 1530 ms native-shaped wall span;
  delayed provider and tool work count, explicit authority/between-step waits do not.
  This is illustrative fixture data, not reconstruction of the live run.
- Aborted background receipt survives journal reopen; revoked authority cannot send
  it; current authority recovers exact sequences. Lost ACK retry preserves payload.
- Actual registered HTTP routes, SQLite, SDK MCP and contained Codex F1 **PASS**:
  136 distinct activity receipts/141 deliveries, 18 result commits/19 transmissions,
  two children, one reconciled engineering publication, five denials. Messages also
  passes. Both hold an intermediate active receipt, complete four delayed model
  responses and two delayed reads, assert no published result, then release ACK and
  verify ordered terminal delivery. Two existing 25-second model turns continue
  measuring over 50 seconds across renewal, with references retained.
- Edge-worker build/typecheck and changed-file lint pass. Repository commit hooks
  additionally require full build/typecheck. Standalone native unit fixture was
  not enabled; the actual native F1 above exercises the contained adapter.

Reproduce after `pnpm build`:

```sh
pnpm --filter cyrus-edge-worker test:run test/automations.test.ts test/session-execution-timing.test.ts test/session-outbox.test.ts test/session-delivery.test.ts
node apps/f1/automation-drive.mjs
CYRUS_TEST_DOCKER_HOST=unix:///var/run/docker.sock CYRUS_F1_CODEX_IMAGE=sha256:35ffa8e695666695f047cf527138b9b27f2e1c29d44673f9eb705a0e4010be4f node apps/f1/automation-drive.mjs
```

Use only an explicitly owned test Docker socket. Image unchanged; no network,
mounts, inherited credentials, image pull or daemon changes. F1 Hosted/provider/model
transports are controlled, not live SQL/UI/model acceptance. Evidence summaries are
in `evidence/cypack-1546-delivery-latency-{messages,native}-summary.json`.
No Connor3456/home, agentops4444, preview mapping or saved live evidence changed.
The precise old pre-native delay and Hosted UI label verification remain open.
