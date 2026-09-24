# End-to-End Self-Hosting Guide

## Quick Start (Recommended)

If you're using any AI coding agent (Claude Code, Codex, Cursor, etc.), set up Miko with a single command:

```bash
npx skills add mikoagents/miko -g
```

Then in your agent:

```
/miko-setup
```

The setup skill builds this fork from source, then walks you through everything below.

---

## Manual Setup

This guide walks you through setting up Miko completely self-hosted, including your own Linear OAuth application. This is the free, zero-cost option that gives you full control.

---

## Prerequisites

- **Linear workspace** with admin access (required to create OAuth apps)
- **Node.js** v22 or higher with npm/npx, plus Git (Git for Windows includes the required Git Bash)
- **jq** (for Claude Code parsing)
- **A public URL** for receiving Linear webhooks

### Install Dependencies

**macOS:**
```bash
brew install jq gh

# Verify
jq --version      # Should show version like jq-1.7
node --version    # Should show v22 or higher
```

**Linux/Ubuntu:**
```bash
apt install -y gh npm git jq

# Verify
jq --version      # Should show version like jq-1.7
node --version    # Should show v22 or higher
```

---

## Overview

You'll complete these steps:

1. Set up a public URL for webhooks
2. Configure Claude Code authentication
3. Create a Linear OAuth application
4. Install Miko and complete your environment file
5. Start Miko, authorize with Linear, and add repositories

> **Tip:** Miko automatically loads environment variables from `~/.miko/.env` on startup. Pass `--env-file=/path/to/your/env` through the verified fork launcher to override it.

---

## Step 1: Set Up Public URL

Linear needs to send webhooks to your Miko instance. Choose one option:

| Option | Best For | Persistence |
|--------|----------|-------------|
| [Cloudflare Tunnel](./CLOUDFLARE_TUNNEL.md) | Production | Permanent URL |
| ngrok | Development/testing | Free static domain included |
| Public server/domain | VPS or cloud hosting | Permanent URL |
| Reverse proxy (nginx/caddy) | Existing infrastructure | Permanent URL |

You'll need:
- A public URL (e.g., `https://miko.yourdomain.com`)
- The URL must be accessible from the internet

---

## Step 2: Configure Claude Code Authentication

Miko needs Claude Code credentials. Choose one option and add it to your env file (`~/.miko/.env`):

**Option A: API Key** (recommended)
```bash
ANTHROPIC_API_KEY=your-api-key
```
Get your API key from the [Anthropic Console](https://console.anthropic.com/).

**Option B: OAuth Token** (for Max subscription users)

Run `claude setup-token` on any machine where you already have Claude Code installed (e.g., your laptop), then add to your env file:
```bash
CLAUDE_CODE_OAUTH_TOKEN=your-oauth-token
```

**Option C: Third-Party Providers**

For Vertex AI, Azure, AWS Bedrock, and other providers, see the [Third-Party Integrations](https://docs.anthropic.com/en/docs/claude-code/bedrock-vertex) documentation.

---

## Step 3: Create Linear OAuth Application

**IMPORTANT:** You must be a **workspace admin** in Linear.

### 3.1 Open Linear Settings

1. Go to Linear: https://linear.app
2. Click your workspace name (top-left corner)
3. Click **Settings** in the dropdown
4. In the left sidebar, scroll down to **Account** section
5. Click **API**
6. Scroll down to **OAuth Applications** section

### 3.2 Create New Application

1. Click **Create new OAuth Application** button

2. Fill in the form:
   - **Name:** `Miko`
   - **Description:** `Self-hosted Miko agent for automated development`
   - **Callback URLs:** `https://your-public-url.com/callback`

3. **Enable Client credentials** toggle

4. **Enable Webhooks** toggle

5. **Configure Webhook Settings:**
   - **Webhook URL:** `https://your-public-url.com/linear-webhook`
   - **App events** - Check these boxes:
     - **Agent session events** (REQUIRED - makes Miko appear as agent)
     - **Inbox notifications** (recommended)
     - **Permission changes** (recommended)

6. Click **Save**

### 3.3 Copy OAuth Credentials

After saving, copy these values:

1. **Client ID** - Long string like `client_id_27653g3h4y4ght3g4`
2. **Client Secret** - Another long string (may only be shown once!)
3. **Webhook Signing Secret** - Found in webhook settings

### 3.4 Add to Environment File

Add these to your env file (`~/.miko/.env`):

```bash
# Linear OAuth configuration
LINEAR_DIRECT_WEBHOOKS=true
LINEAR_CLIENT_ID=client_id_27653g3h4y4ght3g4
LINEAR_CLIENT_SECRET=client_secret_shgd5a6jdk86823h
LINEAR_WEBHOOK_SECRET=lin_whs_s56dlmfhg72038474nmfojhsn7
```

---

## Step 4: Install and Configure Miko

### 4.1 Install Miko

```bash
node "<miko-setup-prerequisites>/scripts/install-fork.mjs"
```

Follow [Fork Installation](./FORK_INSTALLATION.md) to obtain the installer and set `MIKO_ENTRY` to its printed launcher path. Verify `node "$MIKO_ENTRY" --installation` reports the expected fork commit. All commands below use this launcher; the launcher uses the locally built Miko workspace packages.

### 4.2 Complete Your Environment File

Your env file (`~/.miko/.env`) should now contain:

```bash
# Server configuration
LINEAR_DIRECT_WEBHOOKS=true
MIKO_BASE_URL=https://your-public-url.com
MIKO_SERVER_PORT=3456

# Linear OAuth
LINEAR_CLIENT_ID=your_client_id
LINEAR_CLIENT_SECRET=your_client_secret
LINEAR_WEBHOOK_SECRET=your_webhook_secret

# Claude Code authentication (choose one)
ANTHROPIC_API_KEY=your-api-key
# or: CLAUDE_CODE_OAUTH_TOKEN=your-oauth-token

# Optional: Cloudflare Tunnel
# CLOUDFLARE_TOKEN=your-cloudflare-token
```

---

## Step 5: Authorize and Add Repositories

### 5.1 Authorize with Linear

```bash
node "$MIKO_ENTRY" self-auth-linear
```

This will:
1. Start a temporary OAuth callback server
2. Open your browser to Linear's OAuth authorization page
3. After you click **Authorize**, redirect back and save the tokens to your config

#### Additional private Linear apps

One Miko instance can serve private apps from multiple Linear workspaces. Each
app can use the same public callback URL (`/callback`) and webhook URL
(`/linear-webhook`). No additional port, domain, or worker is needed.

Create the private app in the additional workspace using the manifest flow in
`skills/miko-setup-linear/SKILL.md`. Save its settings in a separate file, such as
`~/.miko/linear-nexmoe.env`; keep the existing `~/.miko/.env` unchanged:

```dotenv
MIKO_BASE_URL=https://your-public-url.com
MIKO_SERVER_PORT=3456
MIKO_HOST_EXTERNAL=true
LINEAR_DIRECT_WEBHOOKS=true
LINEAR_CLIENT_ID=the_new_app_client_id
LINEAR_CLIENT_SECRET=the_new_app_client_secret
LINEAR_WEBHOOK_SECRET=the_new_app_webhook_secret
```

Protect this file with `chmod 600`. Wait until Miko is idle, stop the worker to
free its callback port, and keep the tunnel running. Authorize the additional app:

```bash
node "$MIKO_ENTRY" --env-file "$HOME/.miko/linear-nexmoe.env" self-auth-linear
```

Select the new workspace in Linear, then restart the normal Miko service **without
the `--env-file` override**. Authorization saves that app's client ID, client secret,
and webhook secret under the workspace's `linearOAuth` entry in `config.json`.
Other workspaces and repositories are preserved. Protect `config.json` as a secret
file; do not commit it or paste it into chat.

Each workspace uses its own app to verify webhooks and refresh OAuth tokens.
Existing workspaces without `linearOAuth` continue using `LINEAR_CLIENT_ID`,
`LINEAR_CLIENT_SECRET`, and `LINEAR_WEBHOOK_SECRET` from the normal environment.
A workspace with scoped credentials never falls back to another app's webhook
secret. Reauthorizing an app replaces credentials only for its own workspace.

### 5.2 Add a Repository

```bash
node "$MIKO_ENTRY" self-add-repo https://github.com/yourorg/yourrepo.git
```

This clones the repository to `~/.miko/repos/` and configures it with your Linear workspace credentials.

For multiple workspaces, specify which one:
```bash
node "$MIKO_ENTRY" self-add-repo https://github.com/yourorg/yourrepo.git "My Workspace"
```

You can run `node "$MIKO_ENTRY" self-add-repo` while Miko is running. It automatically picks up the new repository configuration.

### 5.3 Start Miko

Once authorization is complete and repositories are added, start Miko:

```bash
node "$MIKO_ENTRY" start
```

Miko automatically loads `~/.miko/.env` on startup. You'll see Miko start up and show logs.

> **Note:** To use a different env file location, pass `--env-file=/path/to/your/env` through the same launcher.

---

## Step 6: Set Up GitHub (Optional)

For Miko to create pull requests, configure Git and GitHub CLI authentication.

See the **[Git & GitHub Setup Guide](./GIT_GITHUB.md)** for complete instructions.

---

## Running as a Service

For 24/7 availability, run Miko as a persistent process.

### Using tmux

```bash
tmux new-session -s miko
node "$MIKO_ENTRY" start
# Ctrl+B, D to detach
# tmux attach -t miko to reattach
```

### Using pm2

```bash
pm2 start "$MIKO_ENTRY" --name miko --interpreter "$(command -v node)" -- start
pm2 save
pm2 startup
```

### Using systemd (Linux)

Create `/etc/systemd/system/miko.service`:

```ini
[Unit]
Description=Miko AI Agent
After=network.target

[Service]
Type=simple
User=your-user
EnvironmentFile=/home/your-user/.miko/.env
ExecStart=/absolute/path/to/node /home/your-user/.local/share/miko/miko.mjs start
Restart=always

[Install]
WantedBy=multi-user.target
```

Then:

```bash
sudo systemctl enable miko
sudo systemctl start miko
```

---

## Configuration

Miko stores its configuration in `~/.miko/config.json`. You can customize tool permissions, issue routing rules, MCP server integrations, and label-based AI modes by editing this file. Miko watches the config file and automatically picks up changes—no restart required.

For detailed options, see the [Configuration File Reference](./CONFIG_FILE.md).

---

## Troubleshooting

### OAuth Authorization Fails

- Verify `MIKO_BASE_URL` matches your Linear OAuth callback URL exactly
- Check that your public URL is accessible from the internet
- Ensure all Linear environment variables are set

### Webhooks Not Received

- Verify Linear webhook URL matches `MIKO_BASE_URL/linear-webhook` (the legacy `/webhook` path still works but is deprecated)
- Check Miko logs for incoming webhook attempts
- Ensure your public URL is accessible

### Repository Not Processing

- Check that the repository is in your config (`~/.miko/config.json`)
- Verify Linear tokens are valid with `node "$MIKO_ENTRY" check-tokens`
- Ensure the issue is assigned to Miko in Linear

### Claude Code Not Working

- Verify your Claude Code credentials are set in the env file
- For API key: Check it's valid at [console.anthropic.com](https://console.anthropic.com/)
- For OAuth token: Run `claude setup-token` again to refresh

---

## Development Mode

If you're developing Miko from source:

```bash
cd /path/to/miko
pnpm install

cd apps/cli
pnpm link --global

# In a separate terminal
pnpm dev

# Then run miko normally
miko
```
