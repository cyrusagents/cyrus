---
name: atmiko-setup-slack
description: Configure Slack integration for Atmiko — create a Slack app from manifest, then guide the user to save credentials.
---

**CRITICAL: Never use `Read`, `Edit`, or `Write` tools on `~/.atmiko/.env` or any file inside `~/.atmiko/`. Use only `Bash` commands (`grep`, `printf >>`, etc.) to interact with env files — secrets must never be read into the conversation context. Never scrape, extract, or read secret values from web pages — guide the user to copy them manually.**

# Setup Slack

Creates a Slack application from a pre-built manifest so Atmiko can respond to messages in Slack channels.

## Step 1: Check Existing Configuration

```bash
grep -E '^SLACK_BOT_TOKEN=' ~/.atmiko/.env 2>/dev/null
```

If `SLACK_BOT_TOKEN` is already set, inform the user:

> Slack is already configured. Skipping this step.
> To reconfigure, remove `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET` from `~/.atmiko/.env` and re-run.

Skip to completion.

## Step 2: Read Variables

Read the base URL (set by `setup-endpoint`):

```bash
grep '^ATMIKO_BASE_URL=' ~/.atmiko/.env | cut -d= -f2-
```

You also need `AGENT_NAME` and `AGENT_DESCRIPTION` — these were collected in Step 0 of the orchestrator and should be available from the conversation context.

## Step 3: Build Manifest JSON

Construct the manifest, substituting `<AGENT_NAME>`, `<AGENT_DESCRIPTION>`, and `<ATMIKO_BASE_URL>` with actual values.

**IMPORTANT: Use the manifest template EXACTLY as shown below.** The event subscription path MUST be `/slack-webhook` (not `/slack/events` or any other path). This matches the route registered by `SlackEventTransport` in the Atmiko codebase.

**Keep this scope list in sync with the manifest below and your own Slack App configuration.**

```json
{
    "display_information": {
        "name": "<AGENT_NAME>",
        "description": "<AGENT_DESCRIPTION>",
        "background_color": "#00240e"
    },
    "features": {
        "bot_user": {
            "display_name": "<AGENT_NAME>",
            "always_online": true
        }
    },
    "oauth_config": {
        "redirect_urls": [
            "<ATMIKO_BASE_URL>/slack/oauth/callback"
        ],
        "scopes": {
            "user": [
                "canvases:read",
                "canvases:write",
                "channels:history",
                "chat:write",
                "groups:history",
                "im:history",
                "mpim:history",
                "users:read",
                "users:read.email",
                "reactions:write",
                "search:read.public",
                "search:read.private",
                "search:read.mpim",
                "search:read.im",
                "search:read.files",
                "search:read.users"
            ],
            "bot": [
                "groups:read",
                "app_mentions:read",
                "assistant:write",
                "canvases:write",
                "channels:history",
                "channels:read",
                "chat:write",
                "chat:write.customize",
                "groups:history",
                "im:history",
                "im:read",
                "files:read",
                "files:write",
                "mpim:history",
                "reactions:write",
                "search:read.files",
                "search:read.public",
                "search:read.users",
                "users:read",
                "users:read.email",
                "mpim:read"
            ]
        },
        "pkce_enabled": false
    },
    "settings": {
        "event_subscriptions": {
            "request_url": "<ATMIKO_BASE_URL>/slack-webhook",
            "bot_events": [
                "app_mention",
                "member_joined_channel",
                "message.channels",
                "message.groups",
                "message.mpim",
                "message.im"
            ]
        },
        "org_deploy_enabled": false,
        "socket_mode_enabled": false,
        "token_rotation_enabled": false
    }
}
```

## Step 4: Create Slack App

**All paths use the "From a manifest" flow.** Never create the app "From scratch".

Determine which browser automation mode to use (see orchestrator rules):

1. If `claude-in-chrome` MCP tools are available → use **Path A-1** (claude-in-chrome)
2. If `agent-browser` is installed and a Chrome debug session is connected → use **Path A-2** (agent-browser)
3. Otherwise → use **Path B** (manual)

### Path A-1: claude-in-chrome Automation

Use the `mcp__claude-in-chrome__*` tools to navigate and interact with the user's existing Chrome browser.

1. Navigate to https://api.slack.com/apps
2. Click **Create New App**
3. Select **From a manifest** in the modal
4. Pick the workspace
5. Click **Next**
6. Select **JSON** tab and paste the manifest from Step 3 (fully substituted with real values)
7. Click **Next**, review, click **Create**

After creation, the app lands on the Basic Information page. **Do NOT take screenshots of credential pages.** Proceed to Step 5 (credential collection).

### Path A-2: agent-browser Automation

If `agent-browser` is connected to a Chrome debug session:

#### 4a. Navigate to Slack app creation

```bash
agent-browser navigate "https://api.slack.com/apps"
```

Take a screenshot to verify the page loaded and the user is logged in.

#### 4b. Click "Create New App"

```bash
agent-browser click "button:text('Create New App')"
```

#### 4c. Select "From a manifest" in the modal

```bash
agent-browser click "button:text('From a manifest')"
```

#### 4d. Select workspace

Take a screenshot to see the workspace picker. Click the appropriate workspace. If multiple are listed, ask the user which one.

```bash
agent-browser click "button:text('Next')"
```

#### 4e. Select JSON format and paste manifest

Click the **JSON** tab if not already selected:

```bash
agent-browser click "button:text('JSON')"
```

Paste the manifest using JavaScript:

```bash
agent-browser eval "var editor = document.querySelector('textarea, [role=\"textbox\"], .ace_editor textarea, .CodeMirror textarea'); if (editor) { var nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; nativeInputValueSetter.call(editor, JSON.stringify(<MANIFEST_JSON>, null, 2)); editor.dispatchEvent(new Event('input', { bubbles: true })); 'pasted'; } else { 'editor not found'; }"
```

If that doesn't work, try:

```bash
agent-browser click "textarea"
agent-browser keyboard "Control+a"
agent-browser type '<MANIFEST_JSON_STRING>'
```

Take a screenshot to verify, then click **Next**:

```bash
agent-browser click "button:text('Next')"
```

#### 4f. Review and create

Take a screenshot to verify the summary, then click **Create**:

```bash
agent-browser click "button:text('Create')"
```

After creation, **do NOT screenshot credential pages or attempt to scrape secrets.** Proceed to Step 5.

### Path B: Manual Guided Setup

Guide the user through the manifest flow:

> ### Create a Slack App
>
> 1. Go to https://api.slack.com/apps
> 2. Click **Create New App**
> 3. In the modal, select **From a manifest**
> 4. Pick the **workspace** you want to associate the app with
> 5. Click **Next**
> 6. Select **JSON** format and paste the following manifest:

Print the fully-substituted manifest JSON for the user to copy.

> 7. Click **Next**, review the summary, then click **Create**

Proceed to Step 5.

## Step 5: Install App & Collect Credentials

After the app is created (via any path), guide the user through installation and credential collection. **The agent must NOT scrape, read, or extract secrets from the page.** The user copies them manually.

### 5a. Install to Workspace

Tell the user:

> 1. In your Slack app settings, go to **Install App** in the left sidebar
> 2. Click **Install to Workspace**
> 3. Click **Allow**

If using browser automation (A-1 or A-2), the agent can navigate to the Install App page and click the buttons — but must **stop after installation completes** and not screenshot the resulting page.

### 5b. Add Credential Placeholders

Add placeholder lines to the env file so the user can fill them in:

```bash
grep -q '^SLACK_BOT_TOKEN=' ~/.atmiko/.env || echo 'SLACK_BOT_TOKEN=' >> ~/.atmiko/.env
grep -q '^SLACK_SIGNING_SECRET=' ~/.atmiko/.env || echo 'SLACK_SIGNING_SECRET=' >> ~/.atmiko/.env
```

### 5c. Open env file for editing

```bash
# macOS
code --new-window ~/.atmiko/.env 2>/dev/null || open -a TextEdit ~/.atmiko/.env
# Linux
code --new-window ~/.atmiko/.env 2>/dev/null || xdg-open ~/.atmiko/.env
```

### 5d. Guide the user to copy credentials

Tell the user:

> I've opened `~/.atmiko/.env`. You need to paste two values:
>
> 1. **Bot User OAuth Token** — go to your app's **OAuth & Permissions** page, copy the **Bot User OAuth Token** (starts with `xoxb-`), and paste it after `SLACK_BOT_TOKEN=`
>
> 2. **Signing Secret** — go to your app's **Basic Information** page, scroll to **App Credentials**, click **Show** next to **Signing Secret**, copy it, and paste it after `SLACK_SIGNING_SECRET=`
>
> Save and close the file when done.

### 5e. Wait and verify

After the user confirms they've saved, verify:

```bash
grep -c '^SLACK_BOT_TOKEN=.' ~/.atmiko/.env
grep -c '^SLACK_SIGNING_SECRET=.' ~/.atmiko/.env
```

Both must return 1 (the `.` after `=` ensures the value is not empty). If either is 0, ask the user to check the file.

## Completion

> ✓ Slack app created from manifest and installed
> ✓ Bot token and signing secret saved to `~/.atmiko/.env`

**Note:** The event subscription `request_url` will fail Slack's verification challenge until Atmiko is actually running. Once Atmiko is started, go to the app's **Event Subscriptions** page and re-enter the URL to trigger verification, or Slack will retry automatically.
