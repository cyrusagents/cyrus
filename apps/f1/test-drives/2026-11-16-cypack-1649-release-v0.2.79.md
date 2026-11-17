# Release v0.2.79: runtime verification

**Date:** 2026-11-16
**Issue:** [CYPACK-1649](https://linear.app/ceedar/issue/CYPACK-1649)
**Tested source:** `3ed8a027` (origin/main) plus release-prep changes (version bumps, changelog moves).
**Previous release:** `v0.2.78`
**Result:** PASS for the checks below. npm publication is a separate gate.

## Full-payload assessment

Merged since v0.2.78: #1596 (`cyrus auth` credential preservation, device metadata, device heartbeat started/stopped in EdgeWorker, Slack requester footer), #1602 (Linear token push to AttachmentService after refresh) and #1604 (personal Slack attribution, shared-runner footer hidden). These touch authentication, EdgeWorker lifecycle and the Slack chat path, so F1 is applicable.

## F1 drive

`pnpm build`, then F1 server on port 3600 against a fresh test repo.

- EdgeWorker started with the device heartbeat; `ping` healthy.
- Linear path: created issue DEF-3 (`[repo=F1 Test Repository]`), started a session. The router posted a repository-selection elicitation; replying through `prompt-session` selected the repo, routing was recorded, and the session ran Claude (Skill/Bash actions, typecheck, commit) and posted a final `response` activity.
- Slack chat path: `start-chat-session` dispatched a synthetic mention; the chat session completed (`subtype: success`, 6 messages) and a chat thread was listed. Slack API posting failed with `channel_not_found` because the fixture has no real Slack workspace.

Limitations: no live Hosted device pairing, heartbeat endpoint, or real Slack workspace, so footer rendering and heartbeat delivery rely on the unit tests. Token-refresh after config reload is covered by the new `EdgeWorker.linear-client-wrapper` unit test, not F1. The elicitation on the first two issues was the router's normal no-match behavior with a single configured repo.

## Other checks

- `pnpm build`, `pnpm typecheck`: passed.
- `pnpm test:packages:run`: all passed (edge-worker 955 passed / 1 skipped, slack-event-transport 104, github-event-transport 127, config-updater 79, claude-runner 150).
- `pnpm --filter cyrus-ai test:run`: 163 passed.
- `pnpm lint`: passed, 14 existing warnings.
- `pnpm audit --audit-level low`: no known vulnerabilities.
