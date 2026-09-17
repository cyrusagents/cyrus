# CYPACK-1502: actual Linear / Claude A and B shared-store acceptance

September 17, 2026 UTC. **Both positive identity runs passed.** Actual Linear
delivery produced fresh draft PR17 and PR18 through personal credentials in the
shared `github-tokens.json`. No mock tracker is used in this drive.

## Tested revisions and isolated setup

- B executed runtime `44be11646265eebcd050b473a8677976da1c5006`.
- A's execution checkout was `e44b9182e9089bc6f2470766b574658b6249e5dc`. Its worker
  process started at `a5c69e63228484cedef8a493c740357f89f8fb83`. All changes from
  `44be1164` through `e44b9182` are evidence Markdown/internal changelog only;
  runtime source is identical. The issue/evidence-file prompt carried the older
  `44be1164` label; the checkout/process revisions here are independently observed.
- Disposable home `/private/tmp/cypack1502-claude-linear-2ntwjiph/home`, separate
  OS HOME/Git/gh/XDG configuration, protected directories and 0600 secret files.
  Both users use canonical `{store:"github-tokens"}` GitHub refs; both personal
  entries coexist in the shared store. Claude secrets remain separate. All four
  policies explicitly reject; Claude/Haiku only, Slack/Zulip disabled.
- Test workspace `c3bbd343-69dd-4899-a201-976015c9c68d`; private test app
  `22fc2749-c61a-4ddd-a6c2-79863fd41d09`, app user
  `9e5beb85-a23a-4d76-b627-742e52f4232f`. Current isolated endpoint is
  `https://horse-start-favourites-seven.trycloudflare.com` with `/callback` and
  `/linear-webhook`, forwarding to port 3743. Local/public `/status` passed.

## Actual Linear and independent GitHub proof

| Evidence | A / Connor | B / CyrusLimited |
| --- | --- | --- |
| Issue | [TEST-407](https://linear.app/cyrusagenttesting/issue/TEST-407) | [TEST-406](https://linear.app/cyrusagenttesting/issue/TEST-406) |
| Issue UUID | `1ed4f8cd-93c9-4b9a-abbc-eb0ee24b2f11` | `3134cb8c-fea6-4687-88b9-e6205e7535b5` |
| Actual human / saved credential owner | `67a670bb-4d83-46ed-b98b-88bb2089d95d` | `917d99c8-c72d-4c22-9167-597f407faae9` |
| Linear session | [`6833cd0a-7f26-4df1-9d19-5d36933414a1`](https://linear.app/cyrusagenttesting/agent-session/6833cd0a-7f26-4df1-9d19-5d36933414a1) | [`77e311b5-5814-4088-a2a0-c7d9c0d988c0`](https://linear.app/cyrusagenttesting/agent-session/77e311b5-5814-4088-a2a0-c7d9c0d988c0) |
| Claude session | `92bf127a-8e66-4e45-9340-8ee4cab26203` | `2ef14f75-18b2-4b13-bba5-c785b274994f` |
| Positive run start/end UTC | `00:40:39.066` / `00:41:17.777` | `00:03:45.296` / `00:04:52.937` |
| Open draft PR / opener | [#18](https://github.com/CyrusAgentTesting/test/pull/18) / `Connoropolous` | [#17](https://github.com/CyrusAgentTesting/test/pull/17) / `CyrusLimited` |
| Head SHA | `8fbe09e381f1ecf525808089712a18c349594ed4` | `60907b8cd38da86944d026ef727253025a2f3bab` |
| Git author **and** committer name | `Connor Turland` | `CyrusLimited` |
| Git author **and** committer email | `1409121+Connoropolous@users.noreply.github.com` | `263804781+CyrusLimited@users.noreply.github.com` |
| GitHub-linked author **and** committer | `Connoropolous` | `CyrusLimited` |
| Only changed file | `credential-evidence/connoropolous-identity-test-407.txt` | `credential-evidence/identity-credentials-20260916.txt` |

The GitHub PR and commit REST APIs independently verified each row's draft state,
opener, head, changed file, author and committer. Both target `main`, remain open
and unmerged. Both identities pushed to the same organization/repository.

A's original delegation at `00:22:27.766Z` became stale while the first temporary
worker/tunnel were down. After recovery, Connor's actual continuation activity
`2a00ff4f-3f71-4af8-a7e5-9e72c6809eaf` at `00:40:37.981Z` carried his expected UUID.
The worker received it at `00:40:38.678Z` and recovered **that same session**.
There was no duplicate dispatch or new session, and no restart after receipt.
Detached worker/tunnel survival across the intervening agent turn is now observed.
The [recovery report](2026-09-16-cypack-1502-claude-linear-recovery.md) preserves
the original endpoint failure and recovery details.

## F1 protocol: tracker, execution, rendering and refusal

Both issues were freshly created in Todo. The Linear API confirms actual human
creator UUIDs and activity actors. Real webhooks, fresh worktrees, Claude tool
activities and saved credential owners connect each trigger to its GitHub proof.
The existing test-repository setup hook requires root/apt and failed; no privileged
installation or hook edit was attempted. Successful setup-hook execution is not
claimed.

Before refusal probes, A had 32 activities (24 actions), paginated `[10,10,10,2]`;
B had 56 activities (32 actions), paginated `[10,10,10,10,10,6]`. All IDs were
unique; timestamps/types and the visible final responses were inspected. Later
follow-ups update Linear's session start/end fields, so the table preserves the
positive execution's timestamps separately.

### B → A: passed

The browser profile was verified as CyrusLimited/cyrusops1 before posting the
bounded probe in A's existing chat. Prompt activity
`cfffc6e8-cc5e-45e5-aed2-28437355db96` at `00:42:12.642Z` has B's UUID and asks for
`printf CY1502_B_TO_A_SHOULD_NOT_RUN`, with no file/PR changes.

Response `5dfae3a8-829f-421d-88bc-27afb8560e61` at `00:42:14.244Z` visibly refuses
the other user's prompt under `followUpByOtherUser=reject`, naming Connoropolous's
assigned credentials. The only new activities were prompt, acknowledgment
thought, and refusal response. **A actions stayed 24; worker runner starts stayed
1 and runner messages stayed 53.** No probe reached Claude or ran a tool.
The screenshot `claude-shared-store-B-to-A-refusal.png` is in the issue attachment
directory. Both saved credential owners remain unchanged.

### A → B: pending

Connor was asked to send the corresponding bounded `CY1502_A_TO_B_SHOULD_NOT_RUN`
probe in B's existing session. Baseline: 32 B actions; worker starts/messages
1/53. No reverse refusal is claimed before its actual prompt and response arrive.

## Limits and cleanup

The worker/tunnel remain available pending the reverse probe. Positive sessions
are complete; resource teardown is not yet claimed. Protected raw evidence stays
in the disposable root, including independent GitHub metadata, full Linear
activity pages, saved owners, and runner/action baselines.

These two Claude tokens belong to one underlying account; separate subscription
isolation is unproven. This drive's positive runs and refusal probes are sequential
and use completed sessions; concurrent/active-session boundaries remain covered
by the separately labeled regression and mock-tracker drives.

Review enforcement remains separate: read-only inspection found `main`
unprotected and no rulesets/classic protections; effective-rule APIs reported
private-repository plan availability and protection access limits. Required human
review/no-bypass, self-approval refusal and another human's review are **not
proven**. The owner must provide enforceable required-review/no-bypass settings
and inspection access before a separately authorized human review exercise. No
rules, billing, visibility, review submissions, merges or bypass changed.
Historical PR11/12 remain historical. Cursor/Codex live prerequisites remain
separate. No internal Cyrus auth change, production deployment or release.
