---
name: miko-setup-repository
description: Add one or more Git repositories to Miko configuration so it can process issues from those repos.
---

**CRITICAL: Never use `Read`, `Edit`, or `Write` tools on `~/.miko/.env` or any file inside `~/.miko/`. Use only `Bash` commands (`grep`, `printf >>`, etc.) to interact with env files — secrets must never be read into the conversation context.**

# Setup Repository

Adds Git repositories to Miko so it knows which codebases to work with.

Use `MIKO_ENTRY` from the prerequisites step. If invoked independently, resolve and verify the fork launcher with `node "<launcher>" --installation` first; install it with the prerequisites skill if missing.

## Step 1: Check Existing Repositories

```bash
cat ~/.miko/config.json 2>/dev/null | grep -o '"url"' | wc -l
```

If repositories are already configured, list them:

```bash
cat ~/.miko/config.json 2>/dev/null
```

Inform the user which repos are already added.

## Step 2: Add a Repository

Ask the user:

> **What is the Git URL of the repository you want Miko to work with?**
> (e.g., `https://github.com/yourorg/yourrepo.git`)

Run:

```bash
node "$MIKO_ENTRY" self-add-repo <url>
```

This clones the repo to `~/.miko/repos/` and registers it with the Linear workspace.

If multiple workspaces are configured, ask which workspace to use:

```bash
node "$MIKO_ENTRY" self-add-repo <url> "<workspace name>"
```

Verify the repo was added:

```bash
cat ~/.miko/config.json | grep "<repo-name>"
```

## Step 3: Add More?

Ask the user:

> **Would you like to add another repository?** (y/n)

If yes, repeat Step 2. If no, continue.

## Completion

> ✓ Repository added: `<url>`
> (repeat for each added repo)
