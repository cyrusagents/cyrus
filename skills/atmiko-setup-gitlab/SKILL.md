---
name: atmiko-setup-gitlab
description: Configure GitLab authentication for Atmiko — glab CLI login and git config for creating merge requests.
---

**CRITICAL: Never use `Read`, `Edit`, or `Write` tools on `~/.atmiko/.env` or any file inside `~/.atmiko/`. Use only `Bash` commands (`grep`, `printf >>`, etc.) to interact with env files — secrets must never be read into the conversation context.**

# Setup GitLab

Configures GitLab CLI and git so Atmiko can create branches, commits, and merge requests.

## Step 1: Check Existing Configuration

Check if `glab` is already authenticated:

```bash
glab auth status 2>&1
```

If authenticated, check git config:

```bash
git config --global user.name
git config --global user.email
```

If both `glab` auth and git config are set, inform the user:

> GitLab is already configured. Skipping this step.

Skip to completion.

## Step 2: Authenticate GitLab CLI

If `glab` is not authenticated:

```bash
glab auth login
```

This opens an interactive browser flow. Let the user complete it.

For self-hosted GitLab instances, the user can specify the hostname:

```bash
glab auth login --hostname gitlab.example.com
```

After completion, verify:

```bash
glab auth status
```

## Step 3: Configure Git Identity

If git user name or email are not set, ask the user for their preferred values:

> **What name should appear on commits made by Atmiko?**
> (e.g., your name, or "Atmiko Bot")

> **What email should appear on commits?**
> (e.g., your email, or a noreply address)

Then set them:

```bash
git config --global user.name "<name>"
git config --global user.email "<email>"
```

## Step 4: Verify

```bash
glab auth status
git config --global user.name
git config --global user.email
```

## Completion

> ✓ GitLab CLI authenticated
> ✓ Git identity configured: `<name>` <`email`>
