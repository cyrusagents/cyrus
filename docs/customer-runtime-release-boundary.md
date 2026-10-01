# Customer feature boundary — October 1, 2026

Connor's capped feature includes chat, context/memory/work, Linear and Slack events
and schedules, and scoped investigation/code handoff returning findings or a PR to
its parent. Direct and ticket-backed delegation remain supported. Read-only
PR/check/status observation remains. Production release orchestration and
cross-customer shared implementation management are deferred, including hidden
background dispatch; hiding UI alone is insufficient. Hosted owns these customer
policy gates. Its ACK is Linear comment `9749237a-9f0e-4cf7-89a7-4522ca717354`.

## Runtime surface inspection

- `automations/Engineering.ts` strictly binds reviewed repository/base/head/files,
  `operations:["execute","publish"]`, `environment:"isolated"`, `deployment:"deny"`.
  `publish_artifact({title,summary})` means a reviewed artifact/PR handoff, not a
  release. The supervisor freezes files and write identity; model arguments cannot
  select a repository, customer, sponsor, deployment or shared link.
- `automations/contract.ts` exposes no production release/promote/shared-link tool.
  Engineering gets execute/publication, no customer read/write grants. Direct and
  optional ticket child admission remains server-owned with narrowed read scope.
- `automations/Gateway.ts` permits only authorize/progress/result/interrupt at the
  fixed authority origin. `automations/register.ts` registers capabilities, wake,
  definitions, occurrences, retry and status. Definitions never authorize execution
  without current Hosted admission. The older `customer-runtime/contract.ts` also
  pins engineering deployment to deny; it is not a registered-path fallback.
- Generic runtime envelopes contain no private sponsor membership. Hosted must deny
  new deferred customer work at action/tool/admission/dispatch boundaries. Adding
  customer tables or sponsor policy to this runtime would duplicate authority and
  break unrelated generic engineering; no such gate is added.
- Immutable terminal receipts and ordered session delivery remain recoverable
  without reopening model/tools/progress. Retaining those records must not execute
  historical pending release/shared actions. Ordinary single-customer cancellation
  and current-authority recovery remain in scope.

## Slack Connect ownership and ordinary-agent guard

Hosted is the **only customer Slack consumer**, behind its existing verified
ingress. It owns configured any-message OR explicit installed-bot mention eligibility,
unique current customer mapping, enabled trigger, membership/read permission, semantic retry/twin
deduplication and accepted-thread reply authority. No rejection/error/missing
mapping may fall through to ordinary Cyrus. Scheduled reads and private UI chat
are separate triggers. Runtime does not add a customer event consumer or reply tool.

The ordinary runtime `/slack-webhook` checks current Slack `auth.test` identity and
`conversations.info` before either `event` or `message` emission. Both direct HMAC
and proxy Bearer verification stay intact. No raw webhook field, upstream thread
binding, routing header or model text can classify a channel as internal.

`SlackChannelPolicy.ts` requires the bot's team to match the envelope; the exact
channel must explicitly be non-external, not pending external sharing, accessible
to the bot and unarchived. Internal Enterprise Grid sharing remains accepted when
explicitly identified. Unknown/missing classification, disconnected credentials,
foreign identity, rate limit, timeout, malformed/oversized response and errors deny
ordinary processing. No positive result is cached. Tokens stay in Authorization,
responses/errors are not logged, redirects are forbidden, calls have a shared
1.5-second deadline and each response is limited to 64 KiB.

Chat entry, queued redispatch and the immediate model-input boundary recheck current
eligibility, as do thread reads, replies and reactions. An old captured event token
cannot authorize a disconnected account. A channel converting to Connect while a
normal turn runs cannot receive its final reply or feed queued follow-ups. This
does not grant the model customer access or migrate an old session to a customer.

Provider API classification requires existing `channels:read` / `groups:read`
permission and membership. This has **not** been verified for the live connection;
missing access fails closed. Direct Slack-to-runtime Connect events are dropped;
customer processing requires Hosted verified ingress. No live subscriptions,
credentials, connection settings or processes are changed by this implementation.
Sources: [conversations.info](https://docs.slack.dev/reference/methods/conversations.info/),
[conversation fields](https://docs.slack.dev/reference/objects/conversation-object/).

## Evidence and remaining review gates

`apps/f1/slack-connect-guard-drive.mjs` exercises real signed/direct and authenticated
proxy routes, real classification/normal chat lifecycle, internal threaded reply,
overlap deduplication, queued channel conversion and removed credentials. Slack
transport and the runner are controlled: it proves **no normal fallback**, not
Hosted customer admission/native execution/reply in either configured trigger mode.

The earlier exact installed04e / Hosted3b5b437f native SQL join retains memory/work,
combined sources, renewal and immutable receipt proof. Event/delegation gaps and
existing fixtures are itemized in [the coverage inventory](automation-event-delegation-coverage.md).
Historical shared-implementation/release evidence is not a required deferred journey.

Remaining capped gates (unproved is not ready):

1. Hosted cap rejects new deferred actions/tools/admission/background dispatch,
   while ordinary scoped engineering and terminal receipt recovery continue.
2. Signed Linear/Slack ingress through current mapping and production outbox to
   native execution, scoped result and durable reply; Slack Connect any-message and explicit-bot-mention trigger
   eligibility, exact originating-thread response and no second consumer.
3. Actual native direct/ticket child and scoped code handoff, findings/PR returned
   once, current parent successor consumes them, durable timeline survives reload.
4. Coordinator-owned representative live source/context/memory/work, schedules,
   isolation/access loss/recovery and responsive conversation acceptance.
5. Complete in-scope desktop/mobile surface, exact-head CI and independent review.

Targets: implementation candidates 13:00 UTC, acceptance 15:00 UTC, ready-for-review
16:00 UTC October 1 (06:00/08:00/09:00 America/Vancouver). The critical dependency is
the new Hosted dual-mode Connect route/reply authority plus joined ingress/child delivery;
normal-agent denial alone cannot close it. No deadline waives evidence, and ready
for review does not authorize merge, release, enablement or live mutation.
