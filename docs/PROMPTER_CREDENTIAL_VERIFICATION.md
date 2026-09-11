# Two-real-user acceptance: CYPACK-1502

Status: **positive two-user execution and PR attribution verified; review
acceptance incomplete**. The [September 11 provider drive](../apps/f1/test-drives/2026-09-11-cypack-1502-provider-acceptance.md)
records successful real Linear sessions, Claude results, authenticated pushes,
and distinct draft-PR authors (Connoropolous / CyrusLimited). Both Claude tokens
belong to the same underlying account. Concurrent real-provider execution was
verified in F1; the real Linear runs were sequential. Required-review/no-bypass
behavior remains unverified because the test repository lacks enforced rules.
Run this checklist on a disposable self-host test instance, using the runtime
from [PR #1472](https://github.com/cyrusagents/cyrus/pull/1472). Do not merge PRs
or deploy production during this verification.

## Required accounts and permissions

- Two consenting engineers A and B, with distinct active Linear IDs in the same
  test workspace and access to delegate/mention Cyrus on the test team. Cyrus
  must have its normal workspace connection and be routed to the test repository.
- Each engineer supplies their own usable Claude subscription OAuth token
  (`claude setup-token`, generated locally) or Anthropic API key with model
  access and available usage. OAuth is not an API key. For subscription proof,
  use two distinct subscriptions; API keys from one organization do not establish
  separate subscription billing. Each owner records the account that issued the
  token and verifies their own provider usage after the run.
- Two distinct GitHub human accounts, both with write access to one disposable
  repository. Each creates their own fine-grained PAT with the repository owner
  selected as resource owner, access to that repository, **Contents: read/write**,
  **Pull requests: read/write**, and **Metadata: read**. Obtain organization token
  approval if required. Do not request workflow access; the test changes a text
  file only. A valid `/user` response alone does not prove push or PR permissions.
- Each engineer supplies their expected GitHub login and a verified account email
  or GitHub noreply email. Profile display names are informational. The CLI checks
  the PAT actor; it does not verify custom git identity fields.
- A repository administrator confirms required human review on the base branch
  and that the test users cannot bypass it. Record the existing rule; do not weaken
  it. A human reviewer with write access verifies review behavior. Neither Cyrus
  nor this checklist merges anything.
- Standard `gh`, Git >= 2.31, Node/Bun and the built Cyrus CLI. Use direct GitHub
  HTTPS access: no CYHOST-913 installation-token wrapper, host credential broker,
  custom model gateway, or operator-managed settings that restore another user's
  credentials. Team Cloud is outside this proposal.

Permission references: [GitHub fine-grained PAT permissions](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens),
[creating PRs](https://docs.github.com/en/rest/pulls/pulls#create-a-pull-request),
[required reviews](https://docs.github.com/en/pull-requests/how-tos/review-pull-requests/approving-a-pull-request-with-required-reviews).
Claude routing/settings precedence: [environment reference](https://code.claude.com/docs/en/env-vars).

## Secure provisioning

Set these nonsecret values in an operator terminal; substitute real test identities:

```bash
export VERIFY_CYRUS_HOME=/absolute/path/to/disposable-cyrus-home
export VERIFY_LINEAR_A=linear-user-id-a
export VERIFY_LINEAR_B=linear-user-id-b
```

Connect this disposable instance to the test Linear workspace and repository using
normal Cyrus setup. Stop any sessions before enabling the mapping and restart the
instance afterwards: an existing process cannot retroactively remove credentials
it already received. Provision both users with hidden prompts (no token arguments):

```bash
cyrus --cyrus-home "$VERIFY_CYRUS_HOME" add-user \
  --linear-user-id "$VERIFY_LINEAR_A" --name "Engineer A" \
  --git-name "Engineer A" --git-email 'A-verified-or-noreply-address'
cyrus --cyrus-home "$VERIFY_CYRUS_HOME" add-user \
  --linear-user-id "$VERIFY_LINEAR_B" --name "Engineer B" \
  --git-name "Engineer B" --git-email 'B-verified-or-noreply-address'
cyrus --cyrus-home "$VERIFY_CYRUS_HOME" check-users --live
```

Do not use `--skip-claude-check` or `--skip-github-check` for positive evidence.
For unattended provisioning, add `--claude-token-file /protected/path` and
`--github-token-file /protected/path` to each add-user command; make the parent
directory 0700 and files 0600. Exchange credentials through the team's secret
manager, not Linear comments. Do not run `env`, `printenv`, `gh auth token`,
`git credential fill`, shell tracing, or token-file reads in recorded sessions.

Record only the two Linear IDs, distinct verified GitHub logins, reference names,
credential fingerprints, and successful check status. Ensure config.json contains
only `{file}` or `{env}` references under `linearUsers`. Review and set this policy
in that disposable config before starting the worker:

```json
{
  "prompterCredentialPolicy": {
    "unmappedPrompter": "reject",
    "nonHumanTrigger": "reject",
    "externalPlatformSessions": "reject",
    "followUpByOtherUser": "reject"
  }
}
```

This chooses strict ownership for the test. The implementation's default `pin`
is still a proposal. Disable Slack/Zulip in this test instance: their chat path
currently uses host credentials and does not implement the external reject policy.

## Concurrent real sessions

A delegates a fresh test issue to Cyrus; B mentions Cyrus on a separate fresh
issue within the same minute. Route both to Claude (`[agent=claude]`), the test
repository and the protected base branch. Give each issue this prompt, replacing
USER and RUN with nonsecret labels:

> Credential acceptance USER/RUN. Confirm `gh api user --jq .login` and
> `git var GIT_AUTHOR_IDENT` / `git var GIT_COMMITTER_IDENT`. Do not inspect or
> print credentials or the environment. Add a unique text file under
> credential-evidence/, commit it, push this issue's branch to origin, and open
> a draft PR against the designated test base branch. Report only your GitHub
> login, commit SHA, author/committer name and email, and PR URL. Do not edit
> workflows, merge, deploy, change review controls, or approve another PR.

Observe two overlapping sessions, successful Claude results and separate
worktrees. Correlate each session's credential fingerprint with provisioning.
For each PR, the operator or owner independently runs these read-only commands
with their normal authenticated GitHub CLI (no credential output):

```bash
gh pr view PR_URL --json author,headRefName,headRefOid,url,isDraft
gh api repos/OWNER/REPO/commits/COMMIT_SHA \
  --jq '{sha, author: .commit.author, committer: .commit.committer, linkedAuthor: .author.login, linkedCommitter: .committer.login}'
```

Capture the successful push in the session and repository push/audit event if
available. A commit's linked author alone does not prove the authenticated push
actor. Record A's PR author = A and B's PR author = B; the two accounts must differ.
Each Claude credential owner confirms the provider account/usage associated with
the successful session. Fingerprints plus success establish selection; if the
provider offers no account-level receipt, label billing attribution as unverified.

## Review and Linear attribution

- In their own GitHub browser session, A tries to approve A's PR; B tries to
  approve B's. Record the disabled control or rejection. Do not use an admin
  bypass. In the test repository, mark drafts ready only when testing reviews.
- The other human reviews and approves the change normally. Confirm the existing
  required-review rule accepts that review and that no merge occurred. GitHub's
  author restriction alone does not enforce all separation-of-duties policies.
- On real Linear, capture the human session creator and the Cyrus thought naming
  the credential user. Capture the final activity as the **Cyrus app**. The SDK
  activity input has no on-behalf-of field; do not claim comments post as A/B.
- B replies to A's thread: under `reject`, observe refusal and no new commit.
  On a separate throwaway session, test `pin`: B's prompt visibly retains A's
  credentials and PR author. That policy permits B to influence A's PR, so it
  does not satisfy strict per-contributor review separation. Obtain a product
  decision before using it for the customer's compliance requirement.

## Negative and lifecycle checks

Use the disposable instance only; restore each fixture before the next case.

| Case | Action | Required result |
| --- | --- | --- |
| Unmapped human | A third unmapped user triggers a new issue, including a child of A's issue | Refusal, no runner/worktree; never inherit A |
| Unknown author | Use F1/unit payload fixtures with no activity/comment author | Reject under strict follow-up policy; never substitute creator |
| Delegation | Identified Cyrus app triggers a child with a known parent session | Inherit that parent's pin; no parent or unknown creator refuses |
| Unreadable | Move A's credential file aside, trigger a fresh issue, then restore it | Reference-only error before worktree creation |
| Invalid/expired | Provision a throwaway invalid token using skip-check flags, then run it | Provider authentication error; never host success. This is negative evidence only |
| Rotation | Re-provision A with `--force`, restart A's runner and prompt again | New fingerprint, same verified actor; existing running turns do not switch tokens |
| Last mapping removed | Remove B; stop A's runner; remove A; prompt A's old session after config reload and after worker restart | Refusal with zero runner starts, never host fallback |
| Running session removal | Remove A while a test session runs, then send a follow-up | Follow-up refused; stop the running session and revoke provider tokens for immediate revocation |
| Unsupported runner | Route a mapped session to OpenCode/Codex/Cursor/Gemini | Explicit refusal, no provider run |
| Config sync | Push normal hosted config omitting local mapping/policy to the test instance | Existing mapping and policy preserved |

## Evidence record and handoff

Fill one row per user. Use `not observed` for any missing result; keep raw logs
local until checked for secret values.

| User | Linear ID/session URL | Claude check/result + owner confirmation | GitHub `/user` login | Push evidence + SHA | Git author/committer | PR URL/author | Self-approval refused | Other human review | Linear actor |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | not observed | not observed | not observed | not observed | not observed | not observed | not observed | not observed | not observed |
| B | not observed | not observed | not observed | not observed | not observed | not observed | not observed | not observed | not observed |

The remaining operator input is two account-owner-provisioned credentials, expected
identities and a designated test workspace/repository with the review rule above.
No one needs to paste tokens into the issue. Stop the test sessions/instance when
finished; close test PRs without merging and remove only the test mappings.
