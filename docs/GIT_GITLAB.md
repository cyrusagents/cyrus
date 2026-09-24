# Git & GitLab Setup

Miko uses your local Git and GitLab CLI (`glab`) authentication to create commits and merge requests. This guide explains how to configure these tools and what permissions Miko will have.

---

## Understanding Permissions

**Important:** Miko operates with the same permissions as your authenticated Git and GitLab CLI user.

When Miko creates commits and MRs:
- All commits are attributed to your Git user (`git config user.name` and `user.email`)
- All MRs are created under your GitLab account
- Your repository access permissions apply to all operations
- Co-authored-by attribution is disabled by default (configured via `.claude/settings.json`)

This means Miko can access any repository your authenticated user can access. Configure authentication carefully based on what repositories you want Miko to work with.

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

Add the public key to your GitLab account at **Preferences > SSH Keys** (e.g., `https://gitlab.com/-/user_settings/ssh_keys`).

---

## GitLab CLI Setup

Install and authenticate the GitLab CLI for MR creation:

### Installation

**macOS:**
```bash
brew install glab
```

**Linux (Debian/Ubuntu):**
```bash
# Add the GitLab CLI repository
curl -s "https://gitlab.com/gitlab-org/cli/-/raw/main/scripts/install.sh" | sudo bash
```

**Other platforms:** See [gitlab.com/gitlab-org/cli](https://gitlab.com/gitlab-org/cli)

### Authentication

```bash
glab auth login
```

Follow the prompts to authenticate. For self-hosted GitLab instances:

```bash
glab auth login --hostname gitlab.example.com
```

For servers without a browser, use a personal access token:

```bash
echo "your-token" | glab auth login --stdin --hostname gitlab.example.com
```

### Verify Setup

```bash
# Check Git config
git config --global user.name
git config --global user.email

# Check GitLab CLI
glab auth status
```

---

## Security Considerations

- **Use a dedicated account** for Miko if you want to limit its access
- **Repository access** is determined by your SSH key and GitLab token permissions
- **Review permissions** before adding repositories to Miko
- **Audit commits** - Miko-authored MRs include a `<!-- generated-by-miko -->` marker for traceability
