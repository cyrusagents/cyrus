# CYPACK-1502: recovered actual Linear → Claude → shared-store GitHub proof

September 16, 2026 (execution timestamps below are September 17 UTC).
**B passed; A and fresh cross-user refusal remain pending.** This is actual Linear
delivery, not F1's mock tracker. Runtime:
`44be11646265eebcd050b473a8677976da1c5006`.
This report supersedes the endpoint/OAuth blockers in the earlier
[readiness report](2026-09-16-cypack-1502-claude-linear-readiness.md).

## Recovery and isolation

- Revalidated obsolete PID 73800 with `lsof`: agentops Node, feature-checkout cwd,
  port 3742, and open `.env` from the old disposable home
  `/private/tmp/cypack1502-positive-ffz8w6df/home`. The attempted graceful SIGTERM
  was denied by the execution sandbox. It remains untouched; no internal or
  unrelated process was stopped. Recovery instead uses free port **3743**.
- Fresh protected home: `/private/tmp/cypack1502-claude-linear-2ntwjiph/home`.
  Both current PAT copies were refreshed, both live Claude/GitHub provisioning
  checks passed, and both canonical user refs point to the shared 0600
  `github-tokens.json`. Separate Claude secrets, all four policies explicitly
  `reject`, Claude/Haiku only, separate OS/Git/gh/XDG homes, Slack/Zulip disabled.
- Inspected the existing private **Cyrus CYPACK-1502 Test** app
  `22fc2749-c61a-4ddd-a6c2-79863fd41d09` in **CyrusAgentTesting**. Changed only its
  two dead endpoint URLs and verified saved values:
  - Callback: `https://craps-values-ton-overall.trycloudflare.com/callback`
  - Webhook: `https://craps-values-ton-overall.trycloudflare.com/linear-webhook`
  Private visibility and Issue / AgentSessionEvent / AppUserNotification /
  PermissionChange subscriptions were preserved. No secret rotation.
- Completed the safe OAuth wrapper without printing raw CLI output or token
  prefixes. The test workspace grant is
  `c3bbd343-69dd-4899-a201-976015c9c68d`; app user is
  `9e5beb85-a23a-4d76-b627-742e52f4232f`. Internal Cyrus auth was not modified.
- New worker PID **27933**, port 3743, receives actual Linear webhooks through the
  replacement tunnel. `GET /status` returns `{"status":"idle"}` after B completes.
  `/health` is not a supported route (404), not used as a health success claim.

## Actual tracker, runner and GitHub evidence

Both fresh issues were created in **Todo** through the test app. The browser is
authenticated as **cyrusops1 / Cyrus Limited**; that human delegated TEST-406 to
the test app. The Linear API independently confirms this user as session creator.

| Evidence | B / CyrusLimited |
| --- | --- |
| Issue | [TEST-406](https://linear.app/cyrusagenttesting/issue/TEST-406), UUID `3134cb8c-fea6-4687-88b9-e6205e7535b5` |
| Actual creator and saved credential owner | `917d99c8-c72d-4c22-9167-597f407faae9` |
| Linear session | [`77e311b5-5814-4088-a2a0-c7d9c0d988c0`](https://linear.app/cyrusagenttesting/agent-session/77e311b5-5814-4088-a2a0-c7d9c0d988c0), complete |
| Session start/end UTC | `2026-09-17T00:03:45.296Z` / `2026-09-17T00:04:52.937Z` |
| Claude session | `2ef14f75-18b2-4b13-bba5-c785b274994f` |
| Draft PR | [#17](https://github.com/CyrusAgentTesting/test/pull/17), open, draft, base `main` |
| Head | `60907b8cd38da86944d026ef727253025a2f3bab` |
| PR opener | `CyrusLimited` |
| Git author **and** committer | `CyrusLimited <263804781+CyrusLimited@users.noreply.github.com>`; both GitHub-linked to `CyrusLimited` |
| Changed file | `credential-evidence/identity-credentials-20260916.txt` only |

GitHub PR and commit API reads independently verified draft state, opener, head,
file list, and both commit identities. No merge, review or bypass was performed.

F1 protocol applied to the real delivery path:

- **Tracker:** fresh Todo issue IDs, actual human delegation, actual webhook
  delivery, API-confirmed creator and completed agent session.
- **Worker:** fresh worktree, live Claude execution, persisted B credential owner,
  actual push/draft creation, successful completion. The existing repository
  setup hook failed because it requires root/apt; no packages were installed and
  the hook was not edited. This does not claim a successful setup-hook run.
- **Renderer:** browser shows cyrusops1 started the session and the final response
  links PR17. API activities contain response/action/thought types and valid
  timestamps. Pagination with `first:10` returned `[10,10,10,10,10,6]`: all 56 IDs
  unique, no gaps relative to the independent single-page read.
- **Cleanup:** B completed and the worker is idle. Worker/tunnel and protected
  credentials are intentionally retained for A's pending trigger; teardown is
  not claimed complete. The old listener could not be retired within the sandbox.

## Exact remaining A interaction

The browser offers only the B account; no Connor login is available. Connor must
open [TEST-407](https://linear.app/cyrusagenttesting/issue/TEST-407) as
**connor@atcyrus.com** and delegate it to **Cyrus CYPACK-1502 Test** (or mention that
app). No further OAuth/setup action is needed while this temporary tunnel lives.

A issue UUID: `1ed4f8cd-93c9-4b9a-abbc-eb0ee24b2f11`; intended Linear actor:
`67a670bb-4d83-46ed-b98b-88bb2089d95d`; intended GitHub actor: **Connoropolous**.
No fresh A session or A draft PR is claimed. After it completes, independently
record the same metadata, then exercise cross-user follow-ups and confirm visible
refusal with no new runner input/actions. Prior offline and Gemini mock-tracker
refusal coverage is separate; this drive has not yet re-proven that boundary.

## Separate acceptance limits

Read-only repository inspection found `main` unprotected, no rulesets or classic
branch protections. Effective-rules APIs returned the private-repository
upgrade/availability error; detailed protection returned PAT-access 403. Thus
**required human review/no-bypass, self-approval refusal and another human's review
remain unproven**. No rules, visibility, billing or review submissions changed.
The owner must first provide and confirm enforceable required-human-review rules
without bypass and allow inspection; a separately authorized human review
exercise can then record self-approval refusal and another human's review without
merging. Current authorization keeps PRs as drafts.

Distinct Claude tokens belong to the **same underlying account**. This is not
separate subscription isolation. Historical Claude PR11/12 are preserved and are
not substituted for A here. Cursor's valid SDK credential and Codex's live shell
sandbox prerequisites remain separate. No implementation change, feature merge,
release, production deployment or customer send occurred.

Protected local evidence includes `fresh-pr-proof.json`, `linear-B-session.json`,
`activity-renderer-proof.json`, and sanitized worker logs under the disposable
root. A screenshot of the actual Linear final response is in the issue attachment
directory as `claude-shared-store-test406.png`; no credential settings are pictured.
