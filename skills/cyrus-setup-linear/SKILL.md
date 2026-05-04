---
name: cyrus-setup-linear
description: Create a Linear OAuth application and configure Cyrus to use it — supports agent-browser automation or guided manual setup.
---

**CRITICAL: Never use `Read`, `Edit`, or `Write` tools on `~/.cyrus/.env` or any file inside `~/.cyrus/`. Use only `Bash` commands (`grep`, `printf >>`, etc.) to interact with env files — secrets must never be read into the conversation context. Never scrape, extract, or read secret values from web pages — guide the user to copy them manually.**

# Setup Linear

Creates a Linear OAuth application and configures credentials so Cyrus can receive webhooks and respond to issues.

## Step 1: Check Existing Configuration

```bash
grep -E '^LINEAR_CLIENT_ID=' ~/.cyrus/.env 2>/dev/null
```

If `LINEAR_CLIENT_ID` is already set, check if OAuth is also complete:

```bash
grep -q '"workspaces"' ~/.cyrus/config.json 2>/dev/null && echo "configured" || echo "not configured"
```

If both are set, inform the user:

> Linear is already configured. Skipping this step.
> To reconfigure, remove `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`, and `LINEAR_WEBHOOK_SECRET` from `~/.cyrus/.env` and re-run.

Skip to completion.

## Step 2: Get CYRUS_BASE_URL

Read the base URL from the env file (set by `setup-endpoint`):

```bash
grep '^CYRUS_BASE_URL=' ~/.cyrus/.env | cut -d= -f2-
```

This is needed for the callback and webhook URLs.

## Step 3: Create Linear OAuth App

Determine which browser automation mode to use (see orchestrator rules):

1. If `claude-in-chrome` MCP tools are available → use **Path A-1** (claude-in-chrome)
2. If `agent-browser` is installed (`which agent-browser`) and a Chrome debug session is connected → use **Path A-2** (agent-browser)
3. Otherwise → use **Path B** (manual)

### Path A-1: claude-in-chrome Automation

Use the `mcp__claude-in-chrome__*` tools to navigate and interact with the user's existing Chrome browser. The user is likely already signed in to Linear.

Navigate to the Linear API settings page and proceed with form filling and credential capture using the chrome MCP tools (navigate, click, fill, screenshot, javascript_tool, etc.). Follow the same form fields and credential scraping logic as Path A-2 below, but using MCP tools instead of CLI commands.

### Path A-2: agent-browser Automation

If `agent-browser` is connected to a Chrome debug session, automate the Linear app creation.

#### 3a. Navigate to Linear API settings

```bash
agent-browser navigate "https://linear.app/settings/api/applications/new"
```

Wait for page to load. Take a screenshot to verify you're on the right page and logged in.

#### 3b. Fill the form

```bash
agent-browser fill "input[name='name']" "<AGENT_NAME>"
agent-browser fill "input[name='developerName']" "Self-hosted"
agent-browser fill "input[name='developerUrl']" "https://github.com/ceedaragents/cyrus"
```

For the callback URL field:
```bash
agent-browser fill "input[name='redirectUrls']" "<CYRUS_BASE_URL>/callback"
```

Enable webhooks and fill webhook URL:
```bash
agent-browser fill "input[name='webhookUrl']" "<CYRUS_BASE_URL>/linear-webhook"
```

Check the required event types:
- Agent session events (REQUIRED)
- Inbox notifications
- Permission changes
- Issues

Click "Create".

After creation, Linear redirects to the app settings page. **Do NOT screenshot credential pages or attempt to scrape secrets.** Proceed to Step 4.

### Path A-1: claude-in-chrome Automation

Use the `mcp__claude-in-chrome__*` tools to navigate and interact with the user's existing Chrome browser.

Navigate to the Linear API settings page (`https://linear.app/settings/api/applications/new`) and fill in the form with the same fields as Path A-2 above. Click "Create". **Do NOT screenshot credential pages or attempt to scrape secrets.** Proceed to Step 4.

### Path B: Manual Guided Setup

Guide the user through manual creation:

> ### Create a Linear OAuth Application
>
> 1. Go to your **Linear workspace settings**:
>    - Click your workspace name (top-left) → **Settings**
>    - Navigate to **API** in the left sidebar
>    - Scroll to **OAuth Applications** → Click **Create new**
>
> 2. Fill in the form:
>    - **Application name:** `<AGENT_NAME>`
>    - **Developer name:** Your name or org
>    - **Developer URL:** `https://github.com/ceedaragents/cyrus`
>    - **Redirect callback URLs:** `<CYRUS_BASE_URL>/callback`
>    - **Webhook URL:** `<CYRUS_BASE_URL>/linear-webhook`
>    - **Webhook:** ✓ enabled
>    - **Event types:** ✓ Agent session events, ✓ Inbox notifications, ✓ Permission changes, ✓ Issues
>    - **Public:** ✗ leave disabled (this is a private self-hosted app)
>
> 3. Click **Create**

Proceed to Step 4.

## Step 4: Collect Credentials

**The agent must NOT scrape, read, or extract secrets from the page.** The user copies them manually into the env file.

### 4a. Add credential placeholders

```bash
grep -q '^LINEAR_CLIENT_ID=' ~/.cyrus/.env || echo 'LINEAR_CLIENT_ID=' >> ~/.cyrus/.env
grep -q '^LINEAR_CLIENT_SECRET=' ~/.cyrus/.env || echo 'LINEAR_CLIENT_SECRET=' >> ~/.cyrus/.env
grep -q '^LINEAR_WEBHOOK_SECRET=' ~/.cyrus/.env || echo 'LINEAR_WEBHOOK_SECRET=' >> ~/.cyrus/.env
```

### 4b. Open env file for editing

```bash
# macOS
code --new-window ~/.cyrus/.env 2>/dev/null || open -a TextEdit ~/.cyrus/.env
# Linux
code --new-window ~/.cyrus/.env 2>/dev/null || xdg-open ~/.cyrus/.env
```

### 4c. Guide the user

Tell the user:

> I've opened `~/.cyrus/.env`. You need to paste three values from your Linear app settings page:
>
> 1. **Client ID** — copy it and paste after `LINEAR_CLIENT_ID=`
> 2. **Client Secret** — click the copy button next to it (it's masked with dots), paste after `LINEAR_CLIENT_SECRET=`
> 3. **Webhook Signing Secret** — click the copy button next to it, paste after `LINEAR_WEBHOOK_SECRET=`
>
> Save and close the file when done.

### 4d. Verify

After the user confirms they've saved:

```bash
grep -c '^LINEAR_CLIENT_ID=.' ~/.cyrus/.env
grep -c '^LINEAR_CLIENT_SECRET=.' ~/.cyrus/.env
grep -c '^LINEAR_WEBHOOK_SECRET=.' ~/.cyrus/.env
```

All three must return 1 (the `.` after `=` ensures the value is not empty). If any are 0, ask the user to check the file.

## Step 5: Authorize with Linear

Run the OAuth authorization flow:

```bash
cyrus self-auth-linear
```

This will:
1. Start a temporary OAuth callback server
2. Open the browser to Linear's authorization page
3. After the user clicks **Authorize**, save tokens to `~/.cyrus/config.json`

Verify authorization succeeded:

```bash
cat ~/.cyrus/config.json | grep -c '"workspaces"'
```

If the count is 0, authorization failed. Ask the user to check their credentials and try again.

## Completion

> ✓ Linear OAuth application created
> ✓ Credentials saved to `~/.cyrus/.env`
> ✓ Workspace authorized via `cyrus self-auth-linear`
