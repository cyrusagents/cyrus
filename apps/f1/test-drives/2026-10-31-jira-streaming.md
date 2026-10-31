# Jira streaming activity: joined real-model drive

Date: October 31, 2026, ~03:25 UTC (receipt written 03:27:20 UTC). Functional heads: runtime `1897b425202cf41a8029716be45ec5eb81dd403e`, Hosted `4dcb94f85425ad6a785e39110d0fe8c7e531ee0d`. This report is documentation only; runtime product code is unchanged from `1897b4252`.

## Scope

**What ran for real**
- The F1 EdgeWorker, idle-upgraded to `1897b4252`, ran on port 3674 against the existing isolated Cyrus home and disposable repository, using native Codex authentication and `gpt-6.1-sol`. The fixture, auth and target were unchanged.
- Hosted ran its actual HTTP A2A boundary, service, migration-backed PGlite ledger and authenticated runtime HTTP bridge.

**What was simulated**
- The Forge invocation token, signed with the test key.
- Jira user identity and issue access.

This is not an Atlassian/Jira SSE acceptance.

**How it was run**
- Driver: a disabled-by-default joined test kept outside the repository (`streaming-joined-live.test.ts`, run with Bun from the Hosted app).
- Scenario: one `SendStreamingMessage` assignment asking Codex to run `pwd`, then a separate shell call that sleeps 12 seconds and prints `STREAMING-OK`, then reply exactly `STREAMING-OK`.

## Results (rerun: 1 pass, 13 assertions, 19.57 s)

Context `38697c80-e8a5-4477-9200-e89fd325d5f1`, task `2277a2a0-7b6b-488c-92af-aa5214d59148`.

**Asserted by the driver:**

1. The stream answered as `text/event-stream`, and its first event is the Task.
2. A fixed-label `Command` activity line arrived on the stream while an independent `GetTask` reported `TASK_STATE_WORKING`. Live tool activity was visible before the answer.
3. After the client canceled the reader, `SubscribeToTask` answered as SSE, and its first event was the same task.
4. That stream reached `COMPLETED`, and a final `GetTask` reported `COMPLETED` with `STREAMING-OK` as the status message.
5. `SubscribeToTask` on the finished task returned plain JSON (`application/json`), code -32004.
6. Retrying the same `SendStreamingMessage` (new JSON-RPC id) returned the same task.
7. The runtime journal held exactly one task, containing `tool_started` and `tool_finished` activity.
8. No stream was left active afterwards.

**Recorded in the receipt but not asserted by the driver:**
- The task had 2 tool starts and 2 finishes. Assertion 7 only checks that each kind is present.
- The event order:
  - first stream: task (SUBMITTED), status WORKING ×2, activity artifact created (`append:false`), status WORKING;
  - resumed stream: task (WORKING), then activity appends (`append:true`) interleaved with WORKING statuses, the result artifact (`append:false`), and finally `statusUpdate` COMPLETED.

  This shows append-only activity updates after reconnect and the final artifact before the terminal status. It is receipt evidence, not an assertion.

**Not observed:**
- No reasoning-summary entry appeared. Codex returned no nonempty `summary[]`, so this run proves tool lifecycle activity only, not reasoning summaries.

## Harness correction during the drive

The first run used the test helper's default synthetic FIT lifetime of 25 seconds:
- Hosted's conservative stream cutoff (15 s before `exp`) correctly closed the resumed stream about 10 s in.
- The roughly 19-second task was still running at that point.
- That driver didn't resubscribe and couldn't detect early EOF, so it timed out after 120 s (0 pass, 4 assertions).

The runtime task itself completed normally, with 2 tool starts and 2 finishes. This was a test-configuration mismatch, not a runtime or stream failure.

The corrected driver issues a 300-second synthetic FIT for this bounded scenario and fails fast on premature EOF. The rerun above passed. The first driver and its log are kept as `streaming-joined-live-v1.test.ts` / `streaming-joined-live-v1.log`.

## Evidence and limits

Task-run artifacts:
- `STREAMING-JOINED-REVIEW.md`
- `streaming-joined-live-receipt.json` (event kinds/states only)
- `streaming-joined-live.test.ts`
- `streaming-joined-live.log`
- the v1 driver and log

No secrets, tokens or auth state are included.

Not established here:
- Real Jira delivery or rendering of SSE status `<details>` and the append-only `Cyrus activity` artifact.
- Jira's automatic resubscribe after stream rotation.
- Follow-up and cancel through Jira.
- The deployed function's real duration.
- Production use.

These are separate live acceptance gates, done after the preview and Forge development deploy. Revocation, slow-consumer, deadline and abort behavior are covered by Hosted and runtime unit/integration tests, not by this drive.
