# GitHub PR follow-through

Two opt-in follow-ups for pull requests owned by this runtime's existing
sessions. Both continue the one existing session for the PR's branch. Neither
starts a session, merges a pull request, or writes to GitHub itself.

- **Merge conflicts** (`mergeConflictTrigger`): when GitHub reports that the PR
  has merge conflicts with its base branch.
- **Branch freshness** (`prBranchFreshness`: `off`, `merge`, `rebase`): when the
  base branch receives a push and the mergeable PR is behind it.

Both are off by default. With freshness `off` Cyrus sends no "base moved"
prompt at all; the old generic base-branch notice to running sessions has
been removed, so these settings control every base-moved prompt.

## Events

GitHub has no merge conflict or "base moved" event for a PR. Cyrus treats these
standard events, received on the existing `POST /github-webhook`, as reasons to
re-read the PR at GitHub:

- `pull_request` with action `opened`, `reopened`, `synchronize`,
  `ready_for_review`, or `edited` when the base branch changed (a retarget).
  Drafts and other actions are ignored. These only check for conflicts.
- `push` to a branch (not a tag, deletion or new branch). A push to a base
  branch emits no `pull_request` event. These check both.

Admission is unchanged: direct delivery verifies GitHub's HMAC
(`x-hub-signature-256`) and the optional IP allowlist before the payload is
used; Hosted delivery verifies the runtime's Bearer key.

## What is checked

The webhook handler only does local checks, then queues bounded background
work, so ordinary webhook handling is not delayed:

1. The relevant setting is on in the live config, and for Hosted deliveries
   also in Hosted's admission (below).
2. Exactly one active configured repository has the event's URL.
3. At least one known session works on a branch of that repository. For a
   `pull_request`, the event's head branch must be one of them; otherwise
   nothing is read from GitHub.

Then, with this runtime's GitHub credential for the repository:

4. The repository's numeric ID at GitHub must match the event.
5. Candidate PRs: the event's PR, or for a base push, open PRs from each owned
   session branch into the pushed branch (at most 10 branches, two results
   each). Open PRs no session owns are never listed.
6. Each candidate is re-read: it must be open, not a draft, and both head and
   base must be this repository (forks are ignored). For a push, its base must
   be the pushed branch. Head and base SHAs must be 40-character hex.
7. Mergeability: GitHub computes it lazily, so an unknown value (`null`) is
   re-read after 2, 4 and 8 seconds. If still unknown, nothing is sent.
   - `mergeable: false`: with merge conflicts on, one conflict prompt using the
     freshness strategy (`merge` when freshness is off). With merge conflicts
     off, nothing: freshness never tries to resolve a conflict.
   - `mergeable: true`, base push, freshness on: GitHub's compare of the pinned
     `head...base` SHAs must show the base ahead (`ahead_by > 0`). Then one
     freshness prompt. Up to date: nothing.
   - `mergeable_state` values such as `blocked` or `behind` are not used.
8. Ownership: exactly one known session must have that PR's head branch, and
   that branch must have exactly one open same-repository PR. Otherwise the
   session cannot be tied to the PR, and nothing is sent.
9. The PR is re-read after the session is prepared and again before dispatch;
   a changed head or base, or a changed decision, stops it.

## Prompts

Identifiers only (repository, PR number, pinned head and base SHAs, strategy,
commits behind, PR URL), XML-escaped and marked untrusted. The agent must
confirm the head and base before acting, and must not switch, reset or rewrite
branches if the workspace, branch or its permissions do not match.

- `merge`: merge the base into the PR branch and push normally; no rebase or
  force push.
- `rebase`: rebase the PR branch onto the base and push only with
  `git push --force-with-lease=<pr-branch>:<head_sha>` pinned to the verified
  head; never an unconditional force push.
- Always: never merge the PR, push to its base, or change its base; keep the
  existing authentication, tool permissions and protected branch rules.

## Deduplication and limits

`~/.cyrus/merge-conflict-dispatch/<sha256(repository-id:pr-number)>/<head-sha>-<base-sha>.json`
journals each dispatch, with a directory lock across processes. Conflicts and
freshness share it: one automatic prompt per head/base pair and **three per
pull request** in total, across redeliveries, push and `pull_request` races,
and restarts. An event arriving while a check of the same PR or base runs is
checked once that run ends (latest wins), so a newer revision is not dropped.
A dispatch interrupted by a crash, or a failed dispatch, needs an operator to
reconcile it, as for [CI failures](./GITHUB_CI_ROUTING.md#deduplication-retries-and-visibility).

Background failures (credentials, GitHub API errors) are logged and not retried.
GitHub does not redeliver on its own; a later qualifying event checks again.

## Configuration

In a directly managed `~/.cyrus/config.json`:

```json
{ "mergeConflictTrigger": true, "prBranchFreshness": "merge" }
```

Removing a key disables it (`false` / `"off"`). The config watcher applies
changes without a restart. Hosted-managed runtimes get both from Automations →
PR Follow-through (shared runner only; personal devices always get them off).

## Credentials

The runtime reads GitHub with its existing credential order: an organization
token from the token store, the installation token Hosted forwards on
authenticated proxy deliveries, a token minted by the self-hosted GitHub App
(`GITHUB_APP_ID` and `GITHUB_APP_INSTALLATION_ID`, with the key at
`~/.cyrus/github-app.pem`), then `GITHUB_TOKEN`. On direct (signature)
delivery any forwarded token header is ignored. It needs **Pull requests:
Read**, **Contents: Read** (compare) and **Metadata: Read**.

## Self-hosted GitHub App subscriptions

For direct delivery, the App must subscribe to **Pull request** and **Push**
events. The setup manifest in the `cyrus-setup-github` skill includes both for
new Apps. Existing Apps need them ticked by hand under **Permissions & events →
Subscribe to events**; upgrading Cyrus does not change App settings.

## Hosted delivery

Hosted forwards the standard signed `pull_request` and `push` events, with
their original bytes and headers, to the workspace's shared runner on this same
endpoint, with `x-cyrus-follow-through: conflicts=on|off; freshness=off|merge|rebase`
from its current workspace settings. That header is honored only after Bearer
authentication; a proxied delivery without it authorizes nothing, and the
runtime's own config must also allow each feature. In direct signature mode it
is ignored. Runtimes acknowledge with `followThroughProtocol: 1`; older runtimes
answer `pull_request` with an ignored success, which Hosted treats as
unsupported.
