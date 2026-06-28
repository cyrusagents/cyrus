---
name: verify-and-ship
description: Runs all quality checks (tests, lint, typecheck), fixes failures, updates the changelog, commits, pushes, and creates or updates the pull/merge request. Use after implementation or debug whenever code changed, before summarize. Not needed for questions or research (use investigate then summarize).
---

# Verify and Ship

Run after code changed, before summarize. Work through the phases in order. Phase 1 gates everything: validate acceptance criteria before shipping. The git/gh/glab and changelog commands below are exact — run them as written. The only flag latitude is the push-recovery escape hatch in Phase 4.

Resolve these from context once: the issue identifier and Linear URL from `<linear_issue>` (`<identifier>` / `<url>`); the target branch from `<git_context>` (or `<context>`) as `<base_branch>`.

Paste this checklist into your response and check items off as you go — Cyrus renders it in the Linear timeline (the ready-state decision in Phase 5 depends on the quality-check result):

```
- [ ] Acceptance criteria validated against the issue
- [ ] Tests, lint, and typecheck run and read
- [ ] Changelog updated (dedup against base branch)
- [ ] Changes committed and pushed
- [ ] PR/MR created or updated with the cyrus marker
- [ ] Ready-state decided: mark ready only if checks pass and guidance allows
```

## Phase 1: Validate acceptance criteria

Fetch the current issue with the issue tracker's `get_issue` tool. Extract every acceptance criterion from the description and confirm the implementation satisfies each one. If the issue states no explicit criteria, validate against the implied requirements in the title and description. Treat unmet criteria as a quality failure surfaced in Phase 5.

## Phase 2: Quality checks

Discover the project's non-interactive check commands first (from package.json, Makefile, or CLAUDE.md) and prefer run-once variants over watch mode — a watch-mode test command never exits and hangs the whole ship. Run each applicable check, read its output, and fix what it reports. Report from fresh command output, never from expectation — no "should pass" or "looks done".

- **Tests** — Run the full suite once (not in watch mode). On failure, fix and re-run. Retry up to 3 times. If failures remain after 3 attempts, stop retrying and carry the failing result into Phase 5 (do not silently ship as passing).
- **Lint** — Run the linter and fix what it flags.
- **Typecheck** — Run type checking (if the project has it) and fix every error.
- **Self-review** — Read the diff. Remove debug code, stray logging, and commented-out blocks.

Record whether checks ended passing or still failing — Phase 5 branches on it.

## Phase 3: Changelog

Inspect state before mutating. Check for changelog files:

```bash
ls -la CHANGELOG.md CHANGELOG.internal.md 2>/dev/null || echo "NO_CHANGELOG"
```

If none exist, skip this phase. Otherwise diff against the base branch (`<base_branch>` from `<git_context>` or `<context>`) to see what this branch already added:

```bash
git diff <base_branch> -- CHANGELOG.md CHANGELOG.internal.md 2>/dev/null
```

- If the diff shows this branch already added an entry for the current issue (matching the issue identifier), update that entry in place — add the PR/MR link or refine the wording. Do not add a duplicate.
- Otherwise add a new entry.

Place entries under `## [Unreleased]` in the right subsection (`### Added`, `### Changed`, `### Fixed`, `### Removed`), focused on end-user impact, in [Keep a Changelog](https://keepachangelog.com/) format. Include the issue identifier and PR/MR link: `([ISSUE-ID](linear_url), [#NUMBER](pr_or_mr_url))`.

## Phase 4: Commit and push

Stage the relevant changes (including the changelog), commit with a clear message following the project's conventions, then push:

```bash
git push -u origin HEAD
```

If the push is rejected as non-fast-forward (e.g. history was rewritten during the Phase 2 retries) and the branch is a Cyrus-owned worktree branch, recover with `git push --force-with-lease`. If the push still fails, stop here and surface the failure — do not open or ready a PR/MR on un-pushed code.

## Phase 5: Create or update the PR/MR

**Pick the platform.** `<repository_routing_context>` renders both `<github_url>` and `<gitlab_url>`; the unused one is the literal `N/A`. If `<github_url>` is a real URL (not `N/A`), follow the **GitHub** branch; otherwise follow the **GitLab** branch. Follow exactly one.

Resolve the bot mention handle once: use `<github_bot_username>` / `<gitlab_bot_username>` from `<agent_context>`. `<agent_context>` is omitted when those env vars are unset, so default to `cyrusagent`. This is the bot, distinct from the PR/MR author (see attribution below).

**Ready-state decision (load-bearing).** If Phase 2 ended with failing checks or Phase 1 found unmet criteria, the branch is not shippable: the PR/MR must be a draft, keep any `WIP:` / `Draft:` prefix, and surface the failures at the top of the body and in your summary. On a re-run where an existing PR/MR was previously marked ready, actively demote it back to draft (GitHub `gh pr ready --undo`; GitLab `glab mr update --draft`) — do not just leave it ready. Only mark ready when checks pass AND `<agent_guidance>` does not call for keeping drafts.

### GitHub branch

Create the draft if absent, otherwise reuse the existing one:

```bash
gh pr view --json url,number 2>/dev/null || gh pr create --draft --base <base_branch> --title "[descriptive title]" --body "Work in progress"
```

Write the rendered body template to a file and set it (use `--body-file` so the multi-line template, blockquote, and marker survive shell quoting):

```bash
gh pr edit --body-file <rendered-template-file>
```

Then apply the ready-state decision — mark ready only when allowed, or demote a now-failing PR back to draft:

```bash
gh pr ready          # only when checks pass and guidance allows
gh pr ready --undo   # only to demote a previously-ready PR that is now failing
```

### GitLab branch

```bash
glab mr view 2>/dev/null || glab mr create --draft --target-branch <base_branch> --title "[descriptive title]" --description "Work in progress"
```

Set the rendered body template as the description:

```bash
glab mr update --description "<rendered template>"
```

Then apply the ready-state decision — mark ready only when allowed, or demote a now-failing MR back to draft:

```bash
glab mr update --ready   # only when checks pass and guidance allows
glab mr update --draft   # only to demote a previously-ready MR that is now failing
```

### Body template (both platforms)

Render this shape; the marker and tip are machine-detected. The assignee line follows the attribution rule below (not a literal copy). The tip text is verbatim user-facing copy — keep its first-person wording; do not rewrite it into imperative.

```
[If checks failing: ## Checks failing — not ready for review
<one line per failing check / unmet criterion>]

<Assignee line — per attribution rule below>

## Summary
<what changed, approach, testing performed>

Closes <ISSUE-ID> — <linear_url>

---

> **Tip:** I will respond to comments that @ mention @<bot_handle> on this PR/MR. You can also leave review comments, and I will automatically wake up to address each comment.

<!-- generated-by-cyrus -->
```

- **Attribution** comes from `<assignee>` inside `<linear_issue>`. On GitHub, if `<github_username>` is present use `Assignee: @<github_username> ([<linear_display_name>](<linear_profile_url>))`; on GitLab, if `<gitlab_username>` (or `<github_username>`) is present use `Assignee: @<username> ([<linear_display_name>](<linear_profile_url>))`. Otherwise `Assignee: [<linear_display_name>](<linear_profile_url>)`. Skip the line if no assignee data exists. Do not derive the bot handle from these usernames — they are the author, not the bot.
- The `<!-- generated-by-cyrus -->` marker stays last; the interaction tip sits just before it; the checks-failing block (if any) stays first.
- Confirm the PR/MR targets `<base_branch>` and fix the target if it drifted.
