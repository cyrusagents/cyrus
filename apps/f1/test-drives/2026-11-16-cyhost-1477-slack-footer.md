# CYHOST-1477: Slack model and device footer

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
