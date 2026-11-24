# GitHub merge conflicts

Opt-in follow-up: when GitHub reports that a pull request owned by one of this
runtime's sessions has merge conflicts with its base branch, Cyrus continues
that existing session with a prompt to merge the base branch in. It never
starts a session, never merges the pull request and never force pushes.

## Events

GitHub has no merge conflict webhook. Cyrus treats these standard events,
received on the existing `POST /github-webhook`, as reasons to re-read the
pull request at GitHub:

- `pull_request` with action `opened`, `reopened`, `synchronize`,
  `ready_for_review`, or `edited` when the base branch changed (a retarget).
  Drafts and other actions are ignored.
- `push` to a branch (not a tag, deletion or new branch). A push to a base
  branch emits no `pull_request` event, but can leave its PRs conflicted. The
  ordinary push handling (the base-branch notice to running sessions) is
  unchanged and still runs.

Admission is unchanged: direct delivery verifies GitHub's HMAC
(`x-hub-signature-256`) and the optional IP allowlist before the payload is
used; Hosted delivery verifies the runtime's Bearer key.

## What is checked

The webhook handler only does local checks, then queues bounded background
work, so ordinary webhook handling is not delayed:

1. `mergeConflictTrigger` is `true` in the live config.
2. Exactly one active configured repository has the event's URL.
3. At least one known session works on a branch of that repository. For a
   `pull_request`, the event's head branch must be one of them; otherwise
   nothing is read from GitHub.

Then, with this runtime's GitHub credential for the repository:

4. The repository's numeric ID at GitHub must match the event.
5. Candidate PRs: the event's PR, or for a base push, open PRs from each
   owned session branch into the pushed branch (at most 10 branches, two
   results each). Open PRs no session owns are never listed.
6. Each candidate is re-read: it must be open, not a draft, and both head
   and base must be this repository (forks are ignored). For a push, its base
   must be the pushed branch.
7. Mergeability: only `mergeable: false` counts. GitHub computes it lazily,
   so an unknown value (`null`) is re-read after 2, 4 and 8 seconds; if still
   unknown, nothing happens until the next qualifying event. `mergeable_state`
   values such as `blocked` or `behind` are not conflicts.
8. Ownership: exactly one known session must have that PR's head branch, and
   that branch must have exactly one open same-repository PR. Otherwise the
   session cannot be tied to the PR, and nothing is sent.
9. The PR is re-read after the session is prepared; a changed head or base, or
   a resolved conflict, stops the dispatch.

## Deduplication and limits

`~/.cyrus/merge-conflict-dispatch/<sha256(repository-id:pr-number)>/<head-sha>-<base-sha>.json`
journals each dispatch, with a directory lock across processes. One automatic
prompt per head/base pair and **three per pull request** in total are allowed,
across redeliveries, push and `pull_request` races, and restarts. A dispatch
interrupted by a crash, or a failed dispatch, needs an operator to reconcile it,
as for [CI failures](./GITHUB_CI_ROUTING.md#deduplication-retries-and-visibility).

Background failures (credentials, GitHub API errors) are logged and not retried.
GitHub does not redeliver on its own; a later qualifying event checks again.

## Configuration

Off by default. In a directly managed `~/.cyrus/config.json`:

```json
{ "mergeConflictTrigger": true }
```

Removing the key or setting `false` disables it. The config watcher applies
changes without a restart. Hosted-managed runtimes get this setting from
Automations → PR Follow-through → Merge conflicts (shared runner only).

## Credentials

The runtime reads GitHub with its existing credential order: an organization
token from the token store, the installation token Hosted forwards on
authenticated deliveries, a token minted by the self-hosted GitHub App
(`GITHUB_APP_ID` and `GITHUB_APP_INSTALLATION_ID`, with the key at `~/.cyrus/github-app.pem`),
then `GITHUB_TOKEN`. It needs **Pull requests: Read** and **Metadata: Read**.

## Self-hosted GitHub App subscriptions

For direct delivery, the App must subscribe to **Pull request** and **Push**
events. The setup manifest in the `cyrus-setup-github` skill now includes both
for new Apps. Existing Apps need them ticked by hand under **Permissions &
events → Subscribe to events**; upgrading Cyrus does not change App settings.

## Hosted delivery

Hosted forwards the standard signed `pull_request` and `push` events, with
their original bytes and headers, to the workspace's shared runner on this
same endpoint. If Hosted's ordinary push delivery went to a different device,
it sends the shared runner a second copy with `x-cyrus-merge-conflict-only: 1`.
That header is honored only after Bearer authentication and only for `push`:
the runtime then skips the ordinary push handling, so the base-branch notice
is not duplicated. In direct signature mode the header is ignored.
Runtimes acknowledge with `mergeConflictProtocol: 1`; older runtimes answer
`pull_request` with an ignored success, which Hosted treats as unsupported.
