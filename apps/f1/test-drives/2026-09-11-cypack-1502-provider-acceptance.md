# CYPACK-1502 real-credential acceptance, September 11

**Status: partial positive evidence; PR authorship, human-triggered Linear sessions,
and review/no-bypass acceptance remain blocked or pending. No merge or deployment.**

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

1. Each PAT owner enables **Pull requests: read/write**, retaining Contents:
   read/write and any needed organization approval. If values change, replace
   the shared files with one token each and request a fresh protected copy.
   [GitHub's create-PR permission requirement](https://docs.github.com/en/rest/pulls/pulls#create-a-pull-request).
2. A repository administrator provides an enforceable main-branch review rule
   with no test-user bypass. The current private/free configuration cannot
   supply this proof. A plan/visibility/repository decision belongs to its owner;
   none was made by the agent.
   [GitHub ruleset availability](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets).
3. In real Linear, connorturland delegates [TEST-404](https://linear.app/cyrusagenttesting/issue/TEST-404)
   and cyrusops1 delegates [TEST-405](https://linear.app/cyrusagenttesting/issue/TEST-405)
   to **Cyrus CYPACK-1502 Test**, ideally within the same minute. These issues were
   created in Todo with the safe draft-PR prompts. Creation by the app is not a
   substitute for delegation by each human. Human-session/final-app activity
   attribution remains pending.
4. Once draft PRs exist and review rules are enforceable, the humans test their
   own self-approval restriction and another human's review. Do not merge.

The two provider-probe branches remain for retry/evidence. F1 sessions and server
were stopped after inspection. The isolated real-webhook worker remains available
for the requested human delegations; no production worker configuration changed.
