---
name: verify-and-ship
description: Run all quality checks (tests, lint, typecheck), fix failures, update the changelog, commit, push, and create/update the pull request or merge request.
---

# Verify and Ship

After implementing your changes, follow these steps to verify quality and ship the work.

## 1. Acceptance Criteria Validation (CRITICAL)

Use the issue tracker `get_issue` tool to fetch the current issue details. Extract ALL acceptance criteria from the issue description and verify each one is satisfied by the implementation. If no explicit criteria exist, validate against the implied requirements from the issue title and description.

## 2. Quality Checks

Run all applicable quality checks:
- **Tests** — Run the full test suite. If tests fail, fix the issues and re-run. Retry up to 3 times. If you cannot resolve failures after 3 attempts, proceed and note the failures in your summary.
- **Linting** — Run linting tools and fix any issues found.
- **Type checking** — Run TypeScript type checking (if applicable) and fix any errors.
- **Code review** — Review your changes for quality, consistency, and best practices. Remove any debug code, console.logs, or commented-out sections.

## 3. Changelog Update

Check if the project has changelog files:
```bash
ls -la CHANGELOG.md CHANGELOG.internal.md 2>/dev/null || echo "NO_CHANGELOG"
```

If changelog files exist, diff against the base branch to detect entries already added by this branch:

```bash
# See what changelog lines this branch has added compared to the base branch
# Replace <base_branch> with the actual base branch from the issue context
git diff <base_branch> -- CHANGELOG.md CHANGELOG.internal.md 2>/dev/null
```

**Handling existing entries:**
- If the diff shows this branch already added a changelog entry for the current issue (matching the issue identifier), **update that entry in-place** (e.g., to add the PR/MR link or refine the description). Do NOT add a duplicate entry.
- If the diff shows this branch added changelog entries for a different issue or no entries at all, add a new entry.

**Adding or updating entries:**
- Place entries under `## [Unreleased]` in the appropriate subsection (`### Added`, `### Changed`, `### Fixed`, `### Removed`)
- Focus on end-user impact — be concise but descriptive
- Include the Linear issue identifier and PR/MR link (format: `([ISSUE-ID](linear_url), [#NUMBER](PR_OR_MR_URL))`)
- Follow [Keep a Changelog](https://keepachangelog.com/) format

## 4. Commit and Push

- Stage all relevant changes (including changelog updates)
- Commit with clear, descriptive messages following the project's commit conventions
- Push to the remote repository

## 5. Create or Update PR/MR

Determine the platform from the repository context (`<github_url>` or `<gitlab_url>` in the issue context). Use the appropriate tool for the platform.

### GitHub (when `<github_url>` is present)

```bash
git push -u origin HEAD
gh pr view --json url,number 2>/dev/null || gh pr create --draft --base [base_branch from context] --title "[descriptive title]" --body "Work in progress"
```

### GitLab (when `<gitlab_url>` is present)

```bash
git push -u origin HEAD
glab mr view 2>/dev/null || glab mr create --draft --target-branch [base_branch from context] --title "[descriptive title]" --description "Work in progress"
```

### PR/MR Description

Update the PR/MR with a comprehensive description:
- **Assignee attribution**: If `<github_username>` is available in the assignee context, add `Assignee: @username ([Display Name](linear_profile_url))` at the top of the body. If only a linear profile URL is available, use `Assignee: [Display Name](linear_profile_url)`.
- **Summary** of changes, implementation approach, and testing performed
- **Link** to the Linear issue
- **Cyrus marker**: Include `<!-- generated-by-cyrus -->` as a hidden HTML comment at the end of the body
- **Interaction tip**: Add this at the end (before the marker), using the bot username from `<github_bot_username>` or `<gitlab_bot_username>` in the `<agent_context>` block of the system prompt. If `<agent_context>` is not present, default to `cyrusagent`:
  ```
  ---
  > **Tip:** I will respond to comments that @ mention @<bot_username> on this PR/MR. You can also submit a review with all your feedback at once, and I will automatically wake up to address each comment.
  ```

Remove any "WIP:" or "Draft:" prefix from the title. Check `<agent_guidance>` — only mark the PR/MR as ready if guidance does NOT specify keeping them as drafts.

Verify the PR/MR targets the correct base branch from `<base_branch>` in the issue context.
