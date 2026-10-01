# CYPACK-1546 — installed native events and child sessions

2026-10-01. Functional fixture change: route the existing Hosted event/child SQL
scenarios through actual contained Codex. No production source changes in this
follow-up. All four modes passed: **87 tests, 1,029 assertions, 110.27 seconds**.

## Exact inputs

- Installed Runtime: `e26a77f85a27649e2e0e30a0f5259061294fc269` (17 packages/copies verified).
- Bundle SHA256: `83d421c8a95862adac1d83f1115685892331b0d5414d220b00200cba07068feb`.
- Frozen Hosted: `a3359a3b9cb3dfde4caee62f7be7441091db215b`.
- Image: `sha256:35ffa8e695666695f047cf527138b9b27f2e1c29d44673f9eb705a0e4010be4f`,
  Linux arm64, preloaded; no pull, mounts or container network.
- Driver hashes:
  - `apps/f1/native-context-join/run-hosted-native.mjs`: `dcb9c0570e5eb58d8177bbe35ca1edd1ecc8b7e056de0a2999f7f0b5220bec72`.
  - `apps/f1/native-context-join/oracle-native.mjs`: `48c0e0a88767e52ab1b23e9d22e9d3f5f036fc37ecaf4624e5e3a61f1411fc6a`.

## Observed behavior

| Mode | Native opens/closes | Model exchanges | Retained assertions |
| --- | --- | --- | --- |
| Linear events | 2/2 | 6 | idle wake, active queued event, dedup, two processed events, session timeline |
| Slack channel events | 2/2 | 6 | idle wake, active queued event, dedup, two processed events, session timeline |
| Direct child | 2/2 | 8 (3 child) | parent link, investigator scope, no manufactured issue, one child result |
| Ticket child | 2/2 | 8 (3 child) | admitted issue/parent link, investigator scope, one child result |

Each mode completed two occurrences through the registered HTTP entry point,
denied four unauthorized routes, and reconciled one lost result ACK with three
transmissions and two committed results. Ordered durable activity receipt and
unique timeline sequence assertions run for all four modes. Native child provider
input excluded private parent context. Existing current-authority, continuation,
foreign workspace/customer, receipt-only recovery and bounded retry tests remain.

The bridge supplies explicit database-only MCP preflight and full SDK authorization
in the frozen fixture; original test and driver sources are preserved alongside
the adapted versions. This is not a production provider-latency measurement.

## Reproduce / evidence

Use [the native bridge instructions](../native-context-join/README.md#existing-hosted-event-and-child-scenarios-through-native-codex)
with the exact inputs above. Select only an authorized disposable Docker socket.
No real login, model spend, live provider mutation or registered live runtime.

Credential-free local evidence:
`/Users/agentops/.cyrus/CYPACK-1546/attachments/slack-connect-e26a77f8/native-a335-sessions/`
contains `inputs.json`, `joined-summary.json`, four mode summaries and
original/adapted source snapshots. Full test log: `/tmp/cypack-native-a335.log`.
Earlier 3b5b-hosted run is preserved separately (87 tests / 993 assertions); it
did not enable event timeline assertions and is not substituted for this run.

## Limits / remaining gates

Model responses and provider identities are synthetic. Prepared outbox delivery
is manual. This does not prove signed Slack/Linear ingress, production dispatcher
wake, current Slack trigger eligibility/thread reply, native parent successor
consuming findings, live ticket assignment or timeline UI reload. Those remain
separate acceptance gates. Event delivery is queued next occurrence, not native
prompt streaming. This fixture does not test the deferred release/shared-work
flows or authorize live installation.
