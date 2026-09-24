# Git & GitHub Setup

Miko uses Git and the GitHub CLI (`gh`) for commits and pull requests. Credential resolution prefers a **GitHub App installation token** when App credentials are configured, and falls back to your local git/`gh` auth otherwise. A GitHub App is **not** required (Linear-only setups keep working).

---

## Credential resolution order

When Miko needs to `git fetch` / `git push` or run `gh` (including PR create) for a repository:

1. **GitHub App installation token** matched to the repo's org/owner — used when App credentials exist (`GITHUB_APP_ID` + `~/.miko/github-app.pem`) and a token can be minted for that installation. Push/PR authorship then appears as **that App's bot** (`<slug>[bot]`). The App name/slug/id is **operator-defined** (whatever you created in setup); Miko does not hard-code a product bot such as `miko-agent[bot]`.
2. **Local git config + `gh auth`** — used when no App is configured, minting fails, or no installation matches the repo.
3. **Clear error** when push/PR is required and neither path can authenticate.

On self-hosted startup (and when adding a repo), Miko mints tokens for known App installations into `~/.miko/github-tokens.json` and wires a git credential helper plus a per-invocation `gh` token resolver so plain `git fetch origin` and `gh` benefit automatically.

---

## Commit authorship

- **App token path:** commits use the operator App bot author form (`<slug>[bot]` / `<appId>+<slug>[bot]@users.noreply.github.com`) via session `GIT_AUTHOR_*` / `GIT_COMMITTER_*` when the App slug is known (`GITHUB_APP_SLUG` or `GITHUB_BOT_USERNAME`).
- **Local fallback:** commits keep your `git config user.name` / `user.email`.
- **Always** append this trailer to commits Miko creates (exactly once; preserve other co-authors). Do **not** change `git user.name` / `user.email` to impersonate mikoagent:

```text
Co-authored-by: mikoagent <332957360+mikoagent@users.noreply.github.com>
```

---

## Understanding Permissions

**Important:** Without a GitHub App, Miko operates with the same permissions as your authenticated Git and GitHub CLI user.

When using local credentials:
- Commits are attributed to your Git user (`git config user.name` and `user.email`)
- PRs are created under your GitHub account
- Your repository access permissions apply

When using an App installation token, repository access is whatever that App installation was granted.

Configure authentication carefully based on what repositories you want Miko to work with.

---

## Git Configuration

Configure Git with your identity (used on the local-credential fallback path):

```bash
git config --global user.name "Your Name"
git config --global user.email "your.email@example.com"
```

### SSH Authentication (Recommended for local fallback)

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

For an inline pull request review comment, Miko replies in the same review thread, including when the request itself is a reply. Ordinary PR timeline comments have no native reply endpoint, so Miko prefixes its response with a direct link to the triggering comment.

Miko adds 👀 to a comment when it accepts the request. A queued request keeps 👀 until it runs. After the task finishes and its reply is delivered, Miko adds 👍 and removes its own 👀 reaction. An unsuccessful task or a failed reply produces 😕 instead. Other people's reactions are left untouched. Review submissions are separate GitHub objects and do not support comment reactions through this API.

Miko does not post receipt or queue-status comments. The agent is instructed to handle the triggering request and return one final answer for Miko to publish, rather than posting its own progress or completion comments. Explicitly requested formal reviews and inline review replies are still supported.

Before starting an automated Codex review request, Miko rechecks the referenced review. If every thread belonging to that exact review is already resolved, the notification gets 👍 without another agent run or summary. This only applies to structured `Review: <review URL>` notifications from `github-actions[bot]` for Codex `COMMENTED` reviews. Human requests, unresolved reviews, and reviews whose completion cannot be verified still run normally.

See GitHub's [review comment reply API](https://docs.github.com/en/rest/pulls/comments#create-a-reply-for-a-review-comment) and [comment reaction API](https://docs.github.com/en/rest/reactions/reactions).

## GitHub CLI Setup

Install and authenticate the GitHub CLI for the local-credential fallback (and as a backup when App minting is unavailable):

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

- **Use a dedicated GitHub App or account** for Miko if you want to limit its access
- **Repository access** is determined by the App installation (preferred) or your SSH key / GitHub token permissions (fallback)
- **Review permissions** before adding repositories to Miko
- **Audit commits** - Miko-authored PRs include a `<!-- generated-by-miko -->` marker for traceability
