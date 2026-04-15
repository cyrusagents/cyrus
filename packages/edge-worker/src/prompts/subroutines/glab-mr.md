# GitLab MR - Merge Request Management

A draft MR exists and all changes have been committed and pushed. Now update the MR with a full description and optionally mark it as ready.

## Your Tasks

### 1. Get MR Information
First, get the current MR URL and verify the target branch:
```bash
glab mr view --output json | jq -r '"\(.web_url) targeting \(.target_branch)"'
```

**IMPORTANT**: Verify that the MR targets the correct target branch (from `<base_branch>` in the issue context). If it doesn't, update it:
```bash
glab mr update --target-branch [correct target branch]
```

### 2. Update MR with Full Description
Update the MR with a comprehensive description:
```bash
glab mr update --title "[descriptive title]" --description "[full description]"
```

**IMPORTANT: Assignee attribution**
Check the `<assignee>` section from the issue context and add assignee information at the **very top** of the MR description, before the summary:

- If a `<gitlab_username>` or `<github_username>` is available, format as: `Assignee: @username ([Display Name](linear_profile_url))`
- If only a `<linear_profile_url>` is available (no username), format as: `Assignee: [Display Name](linear_profile_url)` using the `<linear_display_name>` and `<linear_profile_url>` values

Follow this with a blank line, then the rest of the description. If no assignee information is available at all, skip this step.

**IMPORTANT: Cyrus attribution marker**
You MUST include the following hidden HTML comment somewhere in the MR description (e.g. at the very end). This marker is used to identify Cyrus-authored MRs for tracking purposes:
```
<!-- generated-by-cyrus -->
```
This marker is invisible when rendered on GitLab but allows the webhook to detect that this MR was authored by Cyrus, even when the MR is created under a human user's GitLab account.

The MR description should include:
- Summary of changes
- Implementation approach
- Testing performed
- Any breaking changes or migration notes
- Link to the Linear issue

**IMPORTANT: Cyrus interaction tip**
At the end of the MR description (before the `<!-- generated-by-cyrus -->` marker), include a tip section using the following exact format:

```
---

> **Tip:** I will respond to comments that @ mention @<bot_username from agent_context> on this MR. You can also leave review comments, and I will automatically wake up to address each comment.
```

This helps reviewers know how to interact with Cyrus directly on the MR.

Ensure the MR has a clear, descriptive title (remove "WIP:" or "Draft:" prefix if present).

### 3. Mark MR as Ready (CONDITIONAL)

**CRITICAL**: Before marking the MR as ready, you MUST check the `<agent_guidance>` section in your context.

**DO NOT mark the MR as ready if ANY of the following conditions are true:**
- The agent guidance specifies `--draft` in MR creation commands
- The agent guidance mentions keeping MRs as drafts
- The user has explicitly requested the MR remain as a draft
- The project instructions specify draft MRs

**Only if none of the above conditions apply**, convert the draft MR to ready for review:
```bash
glab mr update --ready
```

### 4. Final Checks
- Confirm the MR URL is valid and accessible
- Verify all commits are included in the MR
- Verify the MR targets the correct target branch (from `<base_branch>` in context)
- Check that CI/CD pipelines start running (if applicable)

## Important Notes

- **A draft MR already exists** - you're updating it and optionally marking it ready
- **All commits are pushed** - the changelog already includes the MR link
- **Be thorough with the MR description** - it should be self-contained and informative
- **RESPECT AGENT GUIDANCE** - if guidance specifies draft MRs, do NOT mark as ready
- **Verify the correct target branch** - ensure MR targets the `<base_branch>` from context
- Take as many turns as needed to complete these tasks

## Expected Output

**IMPORTANT: Do NOT post Linear comments.** Your output is for internal workflow only.

Provide a brief completion message (1 sentence max) that includes the MR URL and status:

If marked as ready:
```
MR ready at [MR URL].
```

If kept as draft (due to agent guidance or user request):
```
Draft MR updated at [MR URL] (kept as draft per guidance).
```

Example: "MR ready at https://gitlab.com/org/repo/-/merge_requests/123."
Example: "Draft MR updated at https://gitlab.com/org/repo/-/merge_requests/123 (kept as draft per guidance)."
