# CYPACK-1502 real-credential acceptance, September 11

**Status: two real Linear users completed Claude runs, authenticated pushes, and
draft PRs under their respective GitHub accounts. Required review/no-bypass
acceptance remains unverified. No merge or deployment.**

The earlier 403s and unmapped-account refusals below are historical observations.
The successful real-session results supersede the PR-permission blocker.

## Isolated setup and OAuth

All five staged files were refreshed from the shared test directory into an
agentops-owned directory under `/private/tmp/cypack1502-positive-ffz8w6df`.
The root/secrets/test-home directories are 0700; secret files are 0600. Both PAT
copies contain exactly one nonempty line. The internal Cyrus home was not used.
OAuth stdout was filtered to fixed status phrases before logging; token values,
prefixes, client IDs and callback codes were discarded.

The existing Connor-managed tunnel reached the temporary callback listener at
port 3742. OAuth completed for **Cyrus CYPACK-1502 Test** in **CyrusAgentTesting**.
The resulting app actor is `9e5beb85-a23a-4d76-b627-742e52f4232f`, workspace
`c3bbd343-69dd-4899-a201-976015c9c68d`. The isolated worker subsequently received
real Issue and AppUserNotification webhooks through that tunnel. The tunnel and
app URLs were not replaced.

The CLI provisioned both mappings with live provider checks enabled. Both Claude
round trips succeeded and both GitHub actors matched. The test configuration uses
Claude/Haiku, strict MCP configuration, a small file/Bash tool allowance, disabled
warm sessions, and `reject` for all four prompter policies. Slack/Zulip are absent.
Per-user credentials in config are file references, not literal tokens.

Initial provisioning (before the account correction below):

| Linear user | Resolved UUID | GitHub actor | Claude fingerprint | PAT fingerprint |
| --- | --- | --- | --- | --- |
| connorturland | 7349aee3-be31-489a-9ae2-81f5d9487efc | Connoropolous | 0dea99a6 | 931b4d62 |
| cyrusops1 | 917d99c8-c72d-4c22-9167-597f407faae9 | CyrusLimited | b2d9b8ac | 01e42a9f |

Fingerprints are truncated SHA-256 digests, never token prefixes. Connor states
that the distinct Claude tokens were issued by the **same underlying Claude
account** and accepts this limitation. Separate subscriptions/billing are not
proved; no provider account-level usage receipt was observed.

## Actual GitHub write probes

Each probe called the built runtime's `resolveLinearUserCredentials` and installed
its Git credential helper. Its subprocesses used the selected PAT for both
`GH_TOKEN` and `GITHUB_TOKEN`, a separate HOME, and empty gh configuration. Each
verified `/user`, committed one plain text evidence file, and pushed its own
branch via Git HTTPS. Both pushes exited 0. GitHub's independent commit response
linked author and committer to the expected account and noreply email.

| Actor | Commit | Draft PR POST |
| --- | --- | --- |
| Connoropolous | [fc1d292bd0b3438c8d3566164f5b8fdbd8e484a2](https://github.com/CyrusAgentTesting/test/commit/fc1d292bd0b3438c8d3566164f5b8fdbd8e484a2) | HTTP 403 |
| CyrusLimited | [f528d822382b7ab7808b3498059a691fea614328](https://github.com/CyrusAgentTesting/test/commit/f528d822382b7ab7808b3498059a691fea614328) | HTTP 403 |

Both actual `POST /repos/CyrusAgentTesting/test/pulls` requests returned
`Resource not accessible by personal access token`, with
`X-Accepted-GitHub-Permissions: pull_requests=write`. Connor's gh PR command also
failed at `repository.pullRequests`. No PR was created. These are direct provider
probes, not Claude-authored PRs or human-triggered Linear sessions. The selected
PAT and successful Git command establish the tested authentication path; a
provider push/audit receipt was not obtained.

Both accounts' repository metadata reports admin/push/pull, but this did **not**
prove PAT PR permissions. Both tokens returned 403 when reading protection,
effective-rule and ruleset APIs. Read-only browser inspection independently found:

- Rulesets: none configured; GitHub says rulesets will not be enforced on this
  private repository until the organization upgrades to GitHub Team.
- Classic branch protection: none configured.

No review settings, visibility, billing, membership or bypass lists were changed.
No approval, merge or bypass was attempted. Account admin metadata and the
GitHub PR-author restriction cannot substitute for an enforced review rule.

## Concurrent F1 drive with real providers

F1 used a fresh local repository with no remote, port 3617, the two real credential
references, and simulated tracker users carrying the resolved UUIDs. Prompts only
requested `gh api user --jq .login`, `git var GIT_AUTHOR_IDENT`, and
`git var GIT_COMMITTER_IDENT`; no additional branches or PRs were created by F1.

The first drive at 19:17:50 UTC completed both Claude sessions successfully with
correct GitHub and git identities. A B-to-A follow-up was explicitly refused
under the strict policy. This drive exposed a persistence race: concurrent saves
shared `edge-worker-state.json.tmp`, causing an ENOENT on rename. It is not
recorded as a clean full-system pass.

A regression reproduced the failure with 20 concurrent saves. State snapshots
are now serialized in request order, preserving atomic replacement and allowing
later saves after a failed write. The repeated drive used a fresh F1 home:
`/tmp/cyrus-f1-1789154405770`.

| F1 session | Runner started (UTC) | Successful result (UTC) | Observed GitHub actor |
| --- | --- | --- | --- |
| session-1 / DEF-1 | 19:20:37.888 | 19:20:45.798 | Connoropolous |
| session-2 / DEF-2 | 19:20:37.893 | 19:20:46.270 | CyrusLimited |

Both used `claude-haiku-4-5-20251001` in separate worktrees. Git author/committer
names and noreply emails matched their mapped accounts. Both persisted session
pins remained present and matched their respective user IDs. No ERROR records
occurred in the repeated drive. The no-remote fixture caused expected fetch
warnings and then used its local main branch. The SDK also warned that bare
allowed-tool entries bypass `canUseTool`; no claim of command-level or OS
sandbox isolation is made. F1 activities included timestamps,
thought/action/response records, and working pagination. F1 uses an in-memory
tracker: its final activities are not evidence of real Linear authorship.

## Real Linear negative-path observation

At 19:23 UTC both TEST-404 and TEST-405 were created as agent sessions by
`connor@atcyrus.com` (`67a670bb-4d83-46ed-b98b-88bb2089d95d`), which is a different
Linear account from the requested `connorturland` mapping. Both repository-selection
replies also came from that unmapped account. The worker refused both sessions
before creating any worktree or runner. It did not borrow either mapped user's
credentials.

The Linear API independently confirmed both session creators and that the refusal
response activities were authored by **Cyrus CYPACK-1502 Test**, app user
`9e5beb85-a23a-4d76-b627-742e52f4232f`:

- TEST-404: session `34530b38-c3a7-40d0-80f9-a3c9038b3699`, response at 19:23:32.397 UTC.
- TEST-405: session `4f00a35d-ee5c-4e05-a6b6-cacccdce5216`, response at 19:23:43.808 UTC.

TEST-team routing now selects the designated repository automatically. At 19:29 UTC
Connor explicitly requested replacement with the actual `connor@atcyrus.com` UUID.
At 19:30 UTC the CLI removed the old `connorturland` mapping and its stored secret
copies, then provisioned `67a670bb-4d83-46ed-b98b-88bb2089d95d` with Connoropolous
and user A’s Claude credential. Both live checks passed, the worker reloaded the
configuration, and its status endpoint returned 200. The `cyrusops1` mapping was
verified unchanged. Both mappings hold file references with mode 0600.
Positive human sessions were still pending at that point; their later results follow.

## Successful real Linear sessions

After the original foreground worker stopped, the test listener was restarted as
a detached process at 19:36 UTC. Both local and existing public tunnel status
endpoints returned 200. A dedicated PM2 attempt encountered sandbox process
monitoring restrictions and was stopped; the internal Cyrus process was untouched.

Fresh human assignments then produced these independently verified results:

| Issue / human | Linear session | Claude run (UTC) | Draft PR / GitHub author | Commit |
| --- | --- | --- | --- | --- |
| TEST-404 / connor@atcyrus.com | a6ceb5f3-e461-4805-8220-1d12db4a8a83 | 19:38:41–19:39:19 | [#11](https://github.com/CyrusAgentTesting/test/pull/11) / Connoropolous | d3d7c35be95517c1dac646f95cc216293a72e56e |
| TEST-405 / cyrusops1 | cdca5786-e92a-47b0-8c69-d1a0d29a83a4 | 19:41:27–19:42:33 | [#12](https://github.com/CyrusAgentTesting/test/pull/12) / CyrusLimited | 385b3c65c7e2721b3b0c316d98dccef79cba529e |

Both sessions returned successful Claude results. Their persisted credential-user
IDs match the respective human creator IDs. GitHub API reads with the mapped PATs
confirmed both PRs are open drafts against main, not merged, and authored by the
expected distinct accounts. Commit author/committer names, noreply emails and
linked GitHub accounts also match. Each commit changes one evidence text file.
Session transcripts contain successful Git pushes and draft-PR commands.

The final Linear comments were independently confirmed as **Cyrus CYPACK-1502
Test**, app user `9e5beb85-a23a-4d76-b627-742e52f4232f`, at 19:39:20.137 and
19:42:33.363 UTC. The child sessions' broad claims that acceptance is complete
apply only to their assigned text-file/PR task; they do not prove review rules or
subscription isolation. These real sessions ran sequentially; concurrency was
verified separately with real-provider F1 sessions above.

Both worktrees encountered an existing fixture setup-hook failure: its OS-package
installation check expected root/apt-get. Cyrus continued and completed the text
file tasks. No OS packages were installed or setup-hook changes made. This was
not a clean repository-setup pass. A scan of 20 protected provider log files found
no matches for either mapped token value or its first 16 characters.

At reinspection after both PRs existed, the browser still showed no rulesets and
no classic branch protections, plus the private-repository GitHub Team notice.
No self-approval attempt, cross-user approval, bypass or merge has been performed.

## Runtime fixes and validation

- Credential CLI commands now shut down their Application after success. A live
  `add-user` exposed an otherwise permanent `.env` watcher; its mapping had saved
  correctly, but the process did not exit. A subprocess regression exercises
  add/list/check/remove with a real watched env file using invalid local fixtures
  and skipped provider checks. The real provisioning above did not skip checks.
- Concurrent state writes are queued and preserve the latest requested snapshot.
  Regression coverage also verifies recovery after a failed write.
- Full monorepo suite: **1,938 passed, 2 skipped**. Core: 170; CLI: 119.
- Build, typecheck and lint passed; lint reported 12 existing warnings.

## Required next interaction

1. A repository administrator provides an enforceable main-branch review rule
   requiring human review with no test-user bypass. The private repository still
   displays the GitHub Team enforcement notice. The account owner must decide
   how to provide enforceable rules; no plan/visibility/repository change was made.
   [GitHub ruleset availability](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets).
2. With enforceable rules in place, the humans use PR #11 and PR #12 to verify
   self-approval refusal and another human's normal review. Mark drafts ready
   only for this review test. Do not merge or use bypass.
3. If simultaneous real-Linear sessions are required in addition to the existing
   concurrent real-provider F1 proof, trigger a fresh pair together. The observed
   real Linear runs were sequential. Separate subscriptions/billing remain
   outside this same-account-token test; no provider account receipt was observed.

The prior PAT PR-write blocker is resolved by actual successful draft-PR creation;
no additional token provisioning is needed for those completed runs. Keep PRs
and evidence branches available for the review test. F1 sessions/servers are
stopped; the isolated detached test worker remains available. No production
worker configuration changed.


## Follow-through: streaming ownership and shared-credential terminology

This is **automated regression evidence**, separate from the real-provider runs
above. The issue-update handler previously streamed title/description edits
without checking the current editor. A new active-runner matrix reproduced eight
failures: other/missing actors received no refusal under `reject`, and `pin`
omitted the ownership notice. The handler now uses the same follow-up policy
before attachment processing and input delivery.

- Title and description updates are covered for same-user, other-user, missing
  actor and integration actor under both `reject` and `pin` (16 cases). Fixtures
  deliberately retain the credential owner's issue creator/assignee fields, so
  those cannot mask a missing or different current actor.
- Strict refusals assert a response activity addressed to the active session,
  zero `addStreamMessage` calls and zero attachment downloads. Pinning accepts
  input with an ownership notice and retains the original credential user.
- Three additional cases cover last-user removal, a running session without a
  credential owner, and preventing a refusal from redirecting the update to a
  different active session. Idle sessions still are not resumed by issue edits.
- Config accepts both `"shared"` and the earlier `"host"` alias for all three
  fallback settings. Resolution and CLI policy output normalize to `"shared"`;
  existing persisted shared-session ownership is unchanged.
- Full monorepo suite: **1,961 passed, 2 skipped** (core 174, edge worker 883,
  CLI 119). Build and typecheck passed; lint passed with 12 existing warnings.
  The public guide compiles as MDX. This does not establish a new real-Linear UI observation
  for the streaming cases, separate Claude subscription isolation or GitHub
  required-review/no-bypass enforcement.
