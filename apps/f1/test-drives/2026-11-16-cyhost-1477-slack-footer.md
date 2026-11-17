# CYHOST-1477: Slack reply footer

The earlier implementations below are historical. The current personal-only footer behavior is recorded at the end.

Date: 2026-11-16

Tested version: PR #1596 working tree based on `a117a6c5`, including the Slack footer changes committed with this report.

## Scenario

Send an authenticated proxy webhook containing a URI-encoded Hosted device name through the real F1 EdgeWorker, Slack transport, chat session, Claude runner and reply adapter. Inspect the outgoing Slack API payload for the selected model and exact device name, in a plain-text context footer under the reply.

## Setup and execution

- Built the runtime and its dependencies with TypeScript (`tsc`); the configured `tsgo` binary is absent locally.
- Started `apps/f1/server.ts` on port 3627 against an empty temporary Git repository. Remote session storage was disabled and Hosted calls pointed at localhost.
- A temporary Bun preload intercepted all `https://slack.com/api/` fetches, returning fixture responses and recording `chat.postMessage` bodies locally. No Slack messages or reactions were sent externally.
- POSTed an `app_mention` to `/slack-webhook` with the fixture Bearer token and `x-cyrus-device-name: Connor%E2%80%99s%20MacBook%20%F0%9F%92%BB`. Requested a short reply without tool use.

## Results

- PASS: proxy webhook accepted with HTTP 200 and `success: true`.
- PASS: the real Claude runner emitted its selected model, `claude-sonnet-4-6`.
- PASS: the captured reply retained the original channel and thread timestamp and included exactly `claude-sonnet-4-6 · Processed on Connor’s MacBook 💻` in an attachment's `context` block with a `plain_text` element.
- BLOCKED: successful model inference. The local Claude OAuth access token had expired (HTTP 401). The captured message was the existing authentication-error reply, so this drive does not certify successful answer generation.
- BLOCKED: visual rendering inside Slack. The Block Kit Builder redirected to workspace sign-in. Payload shape is verified; no live Slack rendering is claimed.
- Stopped the isolated F1 server after inspection.

## Additional checks

- Slack transport package: 86 tests passed, including malformed/Unicode device metadata, ignoring custom headers in direct signature mode, and preserving long reply bodies with plain-text footers.
- EdgeWorker: 954 tests passed, one skipped. Model selection, missing metadata, and silence behavior are covered.
- Companion Hosted changes: 2,130 tests passed, 138 skipped; typecheck and repository lint passed. Routing tests cover renamed personal/shared devices and forwarded metadata without altering the signed Slack body.

## Revised requester-name footer (2026-11-16)

Tested PR #1596 working tree based on `d02f8e19` with the footer revision committed alongside this report.

- Repeated the real `/slack-webhook` → EdgeWorker → Claude runner → reply adapter path on port 3627.
- The local Slack stub returned `UF1` with full name `Connor Turland` and display name `Connor` for `users.info`. The webhook deliberately supplied an unrelated machine name.
- PASS: captured `chat.postMessage` has no `attachments`; the original reply is a top-level `section`, followed by a top-level `context` with a `plain_text` element containing exactly `From Connor Turland's device`.
- PASS: neither model nor Hosted machine name appears in the footer. Original channel/thread and reply text are preserved.
- Successful inference remains blocked by the expired local Claude OAuth token. This exercise validates the outgoing error-reply path; Slack API calls, including the user-profile lookup, were stubbed and no real messages were sent.
- All 97 Slack transport tests and 953 EdgeWorker tests pass (one skipped). Tests cover profile-name fallback, lookup failure without losing replies, silence, top-level block structure, long text, balanced code fences and Unicode section boundaries. Runtime build/typecheck and changed-file Biome pass.
- Visual inspection uses an illustrative local layout preview of the revised footer; it is not proof of rendering inside Slack.
- Stopped the isolated F1 server after inspection.

## Corrected personal/shared attribution (2026-11-17 UTC)

Tested the destination-attribution fix now proposed in PR #1604, using the real F1 server on port 3628, Slack transport, EdgeWorker, Claude runner, reply adapter and message serializer. Slack API responses were stubbed locally; no real messages or reactions were sent. The Claude runner used an empty temporary config directory to avoid using account credentials.

- Sent three authenticated `/slack-webhook` requests with the same synthetic sender `USENDER`, in separate channels/threads: personal metadata identifying owner `UOWNER`, shared metadata naming `Team runner`, and no device metadata.
- PASS: all three requests returned HTTP 200 with `success: true`.
- PASS: the personal reply's context block contained exactly `From Device Owner's device`; the only `users.info` request looked up `UOWNER`, never `USENDER`.
- PASS: the shared reply contained exactly `From Team runner`, with no user-profile lookup.
- PASS: missing metadata produced the reply with no footer or user-profile lookup.
- PASS: original channel/thread and reply text were preserved; personal/shared footers remained plain-text, top-level context blocks without attachments.
- Limitation: the isolated Claude runner returned `Not logged in · Please run /login`. This validates attribution through the actual error-reply path, not successful model inference or live Slack rendering. Successful answer attribution is covered by the adapter tests.
- Validation: 955 EdgeWorker tests passed (one skipped), 104 Slack transport tests passed, and all affected runtime packages built successfully. Companion Hosted routing and webhook tests passed (35 tests) for personal ownership/workspace matching, renamed shared cloud/self-hosted runners, preserved auth headers and exclusive personal routing. Hosted lint and all 11 typecheck tasks passed.
- Stopped the isolated server after verifying all captured payloads.

## Shared footer temporarily hidden (2026-11-17 UTC)

At the user's request, the shared-runner footer assignment is commented out in the runtime. Personal attribution and the authenticated metadata contract remain unchanged.

- Rebuilt the runtime and repeated authenticated personal/shared webhooks through the real F1 server on port 3628 with local Slack API stubs and the isolated unauthenticated Claude config.
- PASS: personal replies still include exactly `From Device Owner's device`, resolving `UOWNER` rather than the different message author.
- PASS: shared replies have no footer/context block and make no profile lookup; both replies preserve their original text and thread timestamp.
- The isolated runner returned its login-error reply. Successful inference and live Slack rendering were not exercised; no real Slack messages were sent.
- All 955 EdgeWorker tests pass (one skipped), including the updated no-shared-footer assertion and tunnel-startup cleanup assertions that track owned timer handles rather than unstable process-wide counts.
- Stopped the isolated server after payload assertions passed.
