# Git & GitHub Setup

Atmiko uses your local Git and GitHub CLI (`gh`) authentication to create commits and pull requests. This guide explains how to configure these tools and what permissions Atmiko will have.

---

## Understanding Permissions

**Important:** Atmiko operates with the same permissions as your authenticated Git and GitHub CLI user.

When Atmiko creates commits and PRs:
- All commits are attributed to your Git user (`git config user.name` and `user.email`)
- All PRs are created under your GitHub account
- Your repository access permissions apply to all operations
- Co-authored-by attribution is disabled by default (configured via `.claude/settings.json`)

This means Atmiko can access any repository your authenticated user can access. Configure authentication carefully based on what repositories you want Atmiko to work with.

---

## Git Configuration

Configure Git with your identity:

```bash
git config --global user.name "Your Name"
git config --global user.email "your.email@example.com"
```

### SSH Authentication (Recommended)

Set up SSH keys for Git operations:

```bash
# Generate SSH key (if you don't have one)
ssh-keygen -t ed25519 -C "your.email@example.com"

# Start the SSH agent
eval "$(ssh-agent -s)"

# Add your key to the agent
ssh-add ~/.ssh/id_ed25519

# Copy the public key
cat ~/.ssh/id_ed25519.pub
```

Add the public key to your GitHub account at [github.com/settings/keys](https://github.com/settings/keys).

---

## Replies to GitHub requests

For an inline pull request review comment, Atmiko replies in the same review thread, including when the request itself is a reply. Ordinary PR timeline comments have no native reply endpoint, so Atmiko prefixes its response with a direct link to the triggering comment.

Atmiko adds 👀 to a comment when it accepts the request. A queued request keeps 👀 until it runs. After the task finishes and its reply is delivered, Atmiko adds 👍 and removes its own 👀 reaction. An unsuccessful task or a failed reply produces 😕 instead. Other people's reactions are left untouched. Review submissions are separate GitHub objects and do not support comment reactions through this API.

Atmiko does not post receipt or queue-status comments. The agent is instructed to handle the triggering request and return one final answer for Atmiko to publish, rather than posting its own progress or completion comments. Explicitly requested formal reviews and inline review replies are still supported.

Before starting an automated Codex review request, Atmiko rechecks the referenced review. If every thread belonging to that exact review is already resolved, the notification gets 👍 without another agent run or summary. This only applies to structured `Review: <review URL>` notifications from `github-actions[bot]` for Codex `COMMENTED` reviews. Human requests, unresolved reviews, and reviews whose completion cannot be verified still run normally.

See GitHub's [review comment reply API](https://docs.github.com/en/rest/pulls/comments#create-a-reply-for-a-review-comment) and [comment reaction API](https://docs.github.com/en/rest/reactions/reactions).

## GitHub CLI Setup

Install and authenticate the GitHub CLI for PR creation:

### Installation

**macOS:**
```bash
brew install gh
```

**Linux (Debian/Ubuntu):**
```bash
sudo apt install gh
```

**Other platforms:** See [cli.github.com](https://cli.github.com/)

### Authentication

```bash
gh auth login
```

Follow the prompts to authenticate. For servers without a browser, use a personal access token:

```bash
gh auth login --with-token < token.txt
```

### Verify Setup

```bash
# Check Git config
git config --global user.name
git config --global user.email

# Check GitHub CLI
gh auth status
```

---

## Security Considerations

- **Use a dedicated account** for Atmiko if you want to limit its access
- **Repository access** is determined by your SSH key and GitHub token permissions
- **Review permissions** before adding repositories to Atmiko
- **Audit commits** - Atmiko-authored PRs include a `<!-- generated-by-atmiko -->` marker for traceability
