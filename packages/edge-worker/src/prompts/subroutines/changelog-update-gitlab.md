# Changelog Update (GitLab) - Document Changes

All verification checks have passed. Now update the changelog if the project uses one.

## Your Tasks

### 1. Push Current Branch and Create Draft MR
First, push the current branch (even if there are no new commits) and create a draft MR to get an MR number:

```bash
# Push the branch to remote
git push -u origin HEAD

# Check if MR already exists, if not create a draft MR
# IMPORTANT: The --target-branch flag MUST match the base_branch from the issue context
glab mr view --output json 2>/dev/null || glab mr create --draft --target-branch [base_branch from context] --title "WIP: [brief description]" --description "Work in progress for [ISSUE-ID]. Full description to follow."
```

Record the MR URL and number for use in the changelog entry.

### 2. Check for Changelog Files
Check if the project has changelog files:
```bash
ls -la CHANGELOG.md CHANGELOG.internal.md 2>/dev/null || echo "NO_CHANGELOG"
```

**If no changelog files exist, complete with:** `Draft MR created at [MR URL]. No changelog files found.`

### 3. Check for Existing Changelog Entry
If changelog files exist, diff against the base branch to detect entries already added by this branch:

```bash
# See what changelog lines this branch has added compared to the base branch
# Replace <base_branch> with the actual target branch from the issue context
git diff <base_branch> -- CHANGELOG.md CHANGELOG.internal.md 2>/dev/null
```

- If the diff shows this branch already added a changelog entry for the current issue (matching the issue identifier), **update that entry in-place** (e.g., to add the MR link or refine the description). Do NOT add a duplicate entry.
- If the diff shows this branch added entries for a different issue or no entries at all, add a new entry in step 4.

### 4. Update Changelog with MR Link
If changelog files exist and no entry exists for this issue on this branch (or the existing entry needs the MR link):

**For user-facing changes (CHANGELOG.md):**
- Add entry under `## [Unreleased]` in the appropriate subsection (`### Added`, `### Changed`, `### Fixed`, `### Removed`)
- Focus on end-user impact from the perspective of users running the CLI
- Be concise but descriptive about what users will experience differently
- Include both the Linear issue identifier AND the MR link
- Format: `- **Feature name** - Description. ([ISSUE-ID](https://linear.app/...), [!NUMBER](MR_URL))`

**For internal/technical changes (CHANGELOG.internal.md):**
- Add entry if the changes are internal development, refactors, or tooling updates
- Follow the same format as CHANGELOG.md

## Important Notes

- **Create draft MR first** - this gives you the MR number to include in the changelog
- **Always specify `--target-branch`** - use the target branch from the `<base_branch>` tag in the issue context. Do NOT rely on the repository's default branch setting.
- **Only update changelogs if they exist** - not all projects use changelogs
- **Avoid duplicate entries** - check if an entry already exists for this issue before adding
- **Follow Keep a Changelog format** - https://keepachangelog.com/
- **Group related changes** - consolidate multiple commits into a single meaningful entry
- **Do NOT commit or push the changelog changes** - that happens in the next subroutine
- Take as many turns as needed to complete these tasks

## Expected Output

**IMPORTANT: Do NOT post Linear comments.** Your output is for internal workflow only.

Provide a brief completion message (1 sentence max):

```
Draft MR created at [MR URL]. Changelog updated for [ISSUE-ID].
```

Or if no changelog exists:

```
Draft MR created at [MR URL]. No changelog files found.
```

Or if entry already existed:

```
Draft MR created at [MR URL]. Changelog entry already exists for this issue.
```
