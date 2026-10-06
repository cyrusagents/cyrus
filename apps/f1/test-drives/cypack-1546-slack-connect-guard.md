# Ordinary Slack Connect exclusion F1 — October 1, 2026

Production source: `e26a77f85a27649e2e0e30a0f5259061294fc269`.
Driver `apps/f1/slack-connect-guard-drive.mjs` SHA256 `841983b7776d594a639cbd7ca091ad53a71f11ae8e4a67e00f12fa752d22dd10`.
The follow-up driver adds unmentioned messages to the original negative matrix;
no executable package changes after e26a. Both customer trigger modes remain Hosted-owned.

## Installed result

PASS with Node26.5.0, isolated prefix `/tmp/cypack-installed-e26a77f8`.
17 packages/17 dependency copies independently stamped with exact sourceSha.
Bundle SHA256 `83d421c8a95862adac1d83f1115685892331b0d5414d220b00200cba07068feb`.

- Actual signed/direct and Bearer/proxy Fastify routes plus normal ChatSessionHandler.
- 24 Connect/unknown/revoked mention/unmentioned deliveries yield zero ordinary
  events, unified messages, model starts or posts. Bad signatures/Bearer tokens
  reach no provider API. Customer trigger selection cannot allow normal fallback.
- Internal mention/message overlap produces one start and one original-thread reply.
  Plain internal follow-up resumes; a subsequent follow-up queues while busy.
- Changing the channel to external before completion suppresses both final reply
  and queued execution. Removed current credentials cannot be revived from the
  captured event token or old thread binding.
- Cleanup closes fixture servers and removes its private temporary home; fetch/env
  restored. No live runtime, home, registration, customer or provider mutation.

Reproduce after the local bundle install/verification:

```sh
node apps/f1/slack-connect-guard-drive.mjs /absolute/isolated-installed-prefix
```

Slack API and runner are controlled; Fastify uses in-process request injection.
This is not a native Codex/Hosted SQL customer journey or a live Slack post.
Existing signatures remain unchanged; the provider guard itself is real.
Focused checks: Slack package102 PASS, chat lifecycle+Zulip71 PASS; required
monorepo build/typecheck and staged lint PASS. Separate CI is recorded in handoff.

## Remaining gates

Hosted must prove both customer trigger modes through current mapping/permission,
signed ingress, durable native delivery, accepted-thread reply and semantic dedup.
This runtime change cannot close that counterpart or live subscription readiness.
See `docs/customer-runtime-release-boundary.md` and the event/delegation inventory.
