# PRs front and center in Linear

*How Cyrus makes its pull requests appear in Linear exactly like Linear's own
coding agent does — attached to the issue, reviewable in Linear's diff view,
pinned on the agent session, and rendered as first-class "Git Push" /
"Create PR" rows in the session timeline.*

This document explains the whole mechanism from first principles so you can
teach it: what Linear provides, what Cyrus does with it, what code changed,
and what a workspace must have configured.

---

## 1. What you see, and where it comes from

When Linear's own coding agent works an issue, the session thread shows rows
like **"Git Push jake/spe-63-test-issue"** and **"Create PR Add
CONTRIBUTING.md"**, the issue gains a **Diff** tab, and the PR opens in a
full review page (`linear.app/<workspace>/review/<slug>`) with inline
comments, *Request review*, approve / request changes, and merge.

None of that is exclusive to Linear's agent. It decomposes into three
independent mechanisms, each with a public API surface:

| What you see | Mechanism | Who provides it |
|---|---|---|
| PR chip on the issue, Diff tab | An issue **attachment** of the GitHub-PR kind | Linear GitHub integration (automatic) or the `attachmentLinkGitHubPR` GraphQL mutation |
| Review page: diffs, inline comments, approve/merge | **Linear Reviews** ("Diffs") — enabled by granting the GitHub integration **code access** to the repo | Linear, for *any* PR in a code-access repo — human, Cursor, Cyrus, or Linear agent alike |
| "Git Push…" / "Create PR…" rows in the thread | Ordinary agent **`action` activities** (`{action, parameter, result}`) | Any agent via `agentActivityCreate` |
| PR link pinned on the session | `agentSessionUpdate` with `addedExternalUrls` | Only the OAuth app that owns the session — i.e. Cyrus's own token |

Two useful extras:

- **URL trick**: any GitHub PR URL maps to its Linear review page by swapping
  the host — `github.com/owner/repo/pull/N` → `linear.review/owner/repo/pull/N`.
- **Re-sync trick**: Linear ingests PRs on webhook events. A PR that predates
  code access won't have a review page until its next event — making a tiny
  edit to the PR description (add/remove a space) triggers ingestion. We
  verified this live: Cyrus's pre-existing PR #16 gained a full review page
  seconds after a whitespace touch.

The only piece that is *not* publicly writable is Linear's internal
session↔PR anchor (`AgentSessionToPullRequest`, marked `[Internal]` in the
schema). It is not needed for any of the visible behavior above.

## 2. What Cyrus does now (the changes)

Four small pieces, layered so no single failure can interrupt a coding
session. All of them ride on infrastructure Cyrus already had.

### 2.1 Semantic timeline rows — `cyrus-claude-runner`

- **`packages/claude-runner/src/git-command-labels.ts`** (new): recognizes
  Bash commands that are semantically a push or a PR/MR creation and returns
  a `{action, parameter}` label:
  - `git push …` (single-command only; a tolerated leading `cd <dir> &&` is
    stripped) → `Git Push` + the pushed branch (refspec-aware).
  - `gh pr create …` → `Create PR` + the `--title`/`-t` value.
  - `glab mr create …` → `Create MR`; `gt submit` → `Create PR`.
  - Deliberately conservative: compound commands like
    `git add … && git commit … && git push` keep their generic `Bash` label,
    because calling that row "Git Push" would hide the other side effects.
- **`packages/claude-runner/src/formatter.ts`**: `formatToolActionName` and
  `formatToolParameter` consult `labelGitCommand()` first for Bash tools, so
  the *existing* activity row is renamed — no duplicate rows are added. The
  raw command and its output still appear in the row's expandable result.

> Scope note: this renders through the Claude runner's formatter. The Codex /
> Gemini / Cursor runner formatters were not touched and still show generic
> rows (their PRs are still attached + pinned — that half is runner-agnostic).

### 2.2 PR detection — `PrMarkerHook`

`packages/edge-worker/src/hooks/PrMarkerHook.ts` already intercepted every
`gh pr create`/`gh pr edit`/`gt submit`/`glab mr *` Bash call (PostToolUse
hook) to stamp the `<!-- generated-by-cyrus -->` marker into the PR body.
It now also:

- exposes `readPullRequest(cwd)` on the GitHub provider — one
  `gh pr view --json number,title,url,isDraft,headRefName` call reading back
  the PR for the session's branch;
- accepts an optional `onPullRequestDetected(pr, cwd)` callback and invokes
  it after the marker step. Errors are logged and swallowed: presentation
  plumbing must never break the coding session.

The GitLab provider does not implement `readPullRequest` yet (candidate
follow-up: `glab mr view` + Linear's `attachmentLinkGitLabMR` mutation).

### 2.3 Plumbing — `RunnerConfigBuilder`

`IssueRunnerConfigInput` gained `onPullRequestDetected?`, which
`buildIssueConfig` passes into `buildPrMarkerHook`. Nothing else in the hook
wiring changed.

### 2.4 Linking — `EdgeWorker` + issue-tracker service

`EdgeWorker.buildAgentRunnerConfig` supplies the callback. On first detection
of a given PR per session (deduped by `sessionId + PR URL`, with the key
released on failure so the next PR-mutating command retries):

1. **Attach the PR to the issue** —
   `LinearIssueTrackerService.linkPullRequestToIssue(issueId, url, title)`
   → SDK `attachmentLinkGitHubPR`. This is what makes the PR appear on the
   issue instantly (rather than waiting for Linear's branch-name sync) and,
   with code access, gives the issue its Diff view.
2. **Pin the PR on the session** —
   `addAgentSessionExternalUrl(externalSessionId, "PR #<n>", url)` →
   `agentSessionUpdate` with `addedExternalUrls` via a **raw GraphQL
   request**, because the pinned `@linear/sdk` (v64) predates that input
   field. `addedExternalUrls` is additive (won't clobber other links), and
   only the OAuth app that owns the session may call it — which is exactly
   the Linear token Cyrus holds.

Both methods are new *optional* members of `IIssueTrackerService`
(`packages/core/src/issue-tracker/IIssueTrackerService.ts`), implemented for
Linear in
`packages/linear-event-transport/src/LinearIssueTrackerService.ts`. The CLI
tracker (F1 test harness) simply omits them.

### Files touched

| File | Change |
|---|---|
| `packages/claude-runner/src/git-command-labels.ts` | new — command recognition |
| `packages/claude-runner/src/formatter.ts` | semantic Bash action/parameter labels |
| `packages/claude-runner/test/git-command-labels.test.ts` | new — label tests |
| `packages/edge-worker/src/hooks/PrMarkerHook.ts` | `DetectedPullRequest`, `readPullRequest`, detection callback |
| `packages/edge-worker/src/RunnerConfigBuilder.ts` | `onPullRequestDetected` pass-through |
| `packages/edge-worker/src/EdgeWorker.ts` | attach + pin callback, dedupe set |
| `packages/core/src/issue-tracker/IIssueTrackerService.ts` | two optional interface methods |
| `packages/linear-event-transport/src/LinearIssueTrackerService.ts` | Linear implementations |
| `packages/edge-worker/test/PrMarkerHook.test.ts` | callback behavior tests |

## 3. One-time workspace setup (no code)

1. **GitHub integration** connected to the Linear workspace, installed on the
   org/repos Cyrus works in (e.g. `specstoryai/adventure`).
2. **Code access** granted to those repos in the GitHub integration settings
   — this is the switch that turns plain PR links into Linear Reviews with
   diffs. (GitHub orgs with IP allow-lists must add Linear's documented IPs.)
3. Each teammate: **Settings → Account → Code & reviews → Enable code
   reviews**, and a connected personal GitHub account (review actions are
   performed as *you* on GitHub).
4. Branch names must contain the issue identifier for Linear's automatic
   PR↔issue linking. Cyrus already branches from Linear's own
   `issue.branchName`, so this holds by construction — and the explicit
   attach in §2.4 covers any repo where it doesn't.
5. *(Optional, recommended)* Have Cyrus open **draft** PRs
   (`gh pr create --draft` in your repo's agent guidance) — then *Request
   review* in Linear flips them ready, matching Linear's agent flow.

## 4. Closing the loop: reviews that drive Cyrus

A review submitted in Linear syncs to GitHub as a real PR review. Cyrus
already listens for `pull_request_review` webhooks (via the Cyrus GitHub
App): a **changes-requested** review on a PR carrying the
`<!-- generated-by-cyrus -->` marker resumes the session with the review
body as the task (config: `prReviewTrigger`, on by default).

So with the GitHub App webhook setup enabled (`cyrus-setup-github`, the
optional @mentions/webhooks part), the full circle is:

```
delegate issue → Cyrus codes → Git Push row → Create PR row
  → PR attached to issue (+ pinned on session) → Diff tab / review page
  → you review in Linear → "Request changes" syncs to GitHub
  → GitHub webhook → Cyrus resumes, fixes, pushes → same review page updates
```

## 5. Verifying / troubleshooting

- **New PR doesn't show a review page**: confirm code access covers that
  repo, and the viewer has the Code reviews toggle on.
- **Old PR (pre-code-access) has no review page**: make a trivial edit to the
  PR description on GitHub — Linear ingests it on the next webhook event.
- **PR not attached to the issue**: check the branch contains the issue
  identifier; with this change, also check cyrus logs for
  `Failed to link PR` (the explicit attach path).
- **Session header shows no PR link**: `addedExternalUrls` requires the
  session to belong to Cyrus's OAuth app — sessions created by other apps
  (or personal API keys) will reject it; the failure is logged and harmless.
- **State automation surprise**: Linear's GitHub workflow automation may move
  the issue (e.g. In Review → In Progress) when a PR links to it. That's
  workspace automation settings, not Cyrus.

## 6. Known limitations

- The `[Internal]` session↔PR anchor (`AgentSessionToPullRequest`) can't be
  set by third-party agents; everything user-visible works without it. The
  review page can still be opened with the agent panel via
  `?showAgent=true&agentSessionId=<id>` query params.
- Semantic rows are Claude-runner only (see §2.1).
- GitLab: marker works; `readPullRequest` / attach not yet implemented.
- If a future `@linear/sdk` upgrade adds `addedExternalUrls` to
  `AgentSessionUpdateInput`, the raw GraphQL call in
  `LinearIssueTrackerService.addAgentSessionExternalUrl` can become a typed
  SDK call.
