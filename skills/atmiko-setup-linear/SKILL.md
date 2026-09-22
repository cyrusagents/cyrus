---
name: atmiko-setup-linear
description: Create a Linear OAuth application and configure Atmiko to use it — supports agent-browser automation or guided manual setup.
---

**CRITICAL: Never use `Read`, `Edit`, or `Write` tools on `~/.atmiko/.env` or any file inside `~/.atmiko/`. Use only `Bash` commands (`grep`, `printf >>`, etc.) to interact with env files — secrets must never be read into the conversation context. Never scrape, extract, or read secret values from web pages — guide the user to copy them manually.**

# Setup Linear

Creates a Linear OAuth application and configures credentials so Atmiko can receive webhooks and respond to issues.

Use the `ATMIKO_ENTRY` path supplied by prerequisites for the OAuth command. If invoked independently, verify the fork launcher with `node "<launcher>" --installation`, or run prerequisites first if it is missing.

## Step 1: Check Existing Configuration

When the user asks to add **another workspace with its own private app**, do not
skip setup because an existing workspace is authorized, and do not replace the
normal `~/.atmiko/.env`. One instance supports multiple private apps:

- Create the new app in the requested workspace using the manifest below, with
  the existing base URL, callback URL, and webhook URL.
- Use a separate credential file, e.g. `~/.atmiko/linear-nexmoe.env`. Include the
  existing `ATMIKO_BASE_URL`, `ATMIKO_SERVER_PORT`, `ATMIKO_HOST_EXTERNAL=true`, and
  `LINEAR_DIRECT_WEBHOOKS=true`, then have the user paste the new app's three
  `LINEAR_*` values into this file. Apply mode `600`; never print its contents.
- At Step 5, wait for the worker to be idle, stop it to free the callback port,
  keep the tunnel running, and run:
  `node "<ATMIKO_ENTRY>" --env-file "<new-credential-file>" self-auth-linear`.
- The command stores the new app credentials in that workspace's `linearOAuth`
  entry in `config.json`, preserving other workspaces. Restart the existing
  service with its normal environment, not the new credential file.
- Check workspace names and credential presence only; never print config tokens
  or app secrets. Do not claim the new workspace is connected until OAuth saves
  the requested workspace.

```bash
grep -E '^LINEAR_CLIENT_ID=' ~/.atmiko/.env 2>/dev/null
```

If `LINEAR_CLIENT_ID` is already set, check if OAuth is also complete:

```bash
grep -q '"workspaces"' ~/.atmiko/config.json 2>/dev/null && echo "configured" || echo "not configured"
```

If both are set, inform the user:

> Linear is already configured. Skipping this step.
> To reconfigure, remove `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`, and `LINEAR_WEBHOOK_SECRET` from `~/.atmiko/.env` and re-run.

Skip to completion.

## Step 2: Get ATMIKO_BASE_URL

Read the base URL from the env file (set by `setup-endpoint`):

```bash
grep '^ATMIKO_BASE_URL=' ~/.atmiko/.env | cut -d= -f2-
```

This is needed for the callback and webhook URLs.

## Step 3: Create Linear OAuth App From Manifest

Linear OAuth apps must be created from a manifest-backed setup URL. Do not create the app from scratch or fill each field manually. The manifest flow keeps the app configuration reproducible and avoids drift in callback, webhook, and event type settings.

### 3a. Build the manifest URL

Generate a JSON OAuth app manifest and encode it into Linear's `manifest` query parameter:

```bash
ATMIKO_BASE_URL="<ATMIKO_BASE_URL>" \
AGENT_NAME="<AGENT_NAME>" \
AGENT_DESCRIPTION="<AGENT_DESCRIPTION>" \
node <<'NODE'
const fs = require("node:fs");

const baseUrl = process.env.ATMIKO_BASE_URL.replace(/\/+$/, "");
const agentName = process.env.AGENT_NAME || "Atmiko";
const agentDescription =
	process.env.AGENT_DESCRIPTION || "AI coding agent for automated development";

const manifest = {
	$schema: "https://linear.app/.well-known/oauth-app-manifest.schema.json",
	schemaVersion: "1.0.0",
	distribution: "private",
	display: {
		description: agentDescription,
	},
	developer: {
		name: "Self-hosted",
	},
	oauth: {
		client_name: agentName,
		client_uri: "https://github.com/nexmoe/atmiko",
		redirect_uris: [`${baseUrl}/callback`],
		grant_types: ["authorization_code"],
	},
	webhook: {
		enabled: true,
		url: `${baseUrl}/linear-webhook`,
		resourceTypes: [
			"AgentSessionEvent",
			"AppUserNotification",
			"PermissionChange",
			"Issue",
		],
	},
};

const manifestJson = JSON.stringify(manifest, null, 2);
const manifestUrl = `https://linear.app/settings/api/applications/new?manifest=${encodeURIComponent(JSON.stringify(manifest))}`;

fs.writeFileSync("/tmp/atmiko-linear-oauth-app-manifest.json", `${manifestJson}\n`);
fs.writeFileSync("/tmp/atmiko-linear-oauth-app-url.txt", `${manifestUrl}\n`);

console.log(manifestJson);
console.log(`\n${manifestUrl}`);
NODE

LINEAR_MANIFEST_URL="$(cat /tmp/atmiko-linear-oauth-app-url.txt)"
```

The same URL is now stored in `LINEAR_MANIFEST_URL` for automation commands and in `/tmp/atmiko-linear-oauth-app-url.txt` for manual copy/paste. The JSON is stored in `/tmp/atmiko-linear-oauth-app-manifest.json` for review/debugging only; do not ask the user to fill the OAuth app form manually from it.

If `<AGENT_NAME>` contains the word "Linear" or a URL, choose a different OAuth application name before building the manifest. Linear rejects OAuth client names with those values.

Determine which browser automation mode to use (see orchestrator rules):

1. If `claude-in-chrome` MCP tools are available → use **Path A-1** (claude-in-chrome)
2. If `agent-browser` is installed (`which agent-browser`) and a Chrome debug session is connected → use **Path A-2** (agent-browser)
3. Otherwise → use **Path B** (manual)

### Path A-1: claude-in-chrome Automation

Use the `mcp__claude-in-chrome__*` tools to navigate and interact with the user's existing Chrome browser. The user is likely already signed in to Linear.

Navigate to `LINEAR_MANIFEST_URL`. The page should open with the manifest-applied OAuth app configuration already populated.

Review only non-secret fields:

- Application name matches `<AGENT_NAME>`
- Developer name is `Self-hosted`
- Developer URL is `https://github.com/nexmoe/atmiko`
- Redirect callback URLs contains `<ATMIKO_BASE_URL>/callback`
- Webhook is enabled with URL `<ATMIKO_BASE_URL>/linear-webhook`
- Event types include Agent session events, Inbox notifications, Permission changes, and Issues
- Public/distribution is private or disabled

If the user is not signed in, pause and ask them to sign in. After review, click **Create**. **Do NOT screenshot credential pages or attempt to scrape secrets.** Proceed to Step 4.

### Path A-2: agent-browser Automation

If `agent-browser` is connected to a Chrome debug session, automate the Linear app creation.

#### 3b. Navigate to the manifest URL

```bash
agent-browser navigate "$LINEAR_MANIFEST_URL"
```

Wait for page to load. Take a screenshot to verify you're on the right page and logged in.

#### 3c. Review and create

Review the same non-secret manifest-applied fields listed in Path A-1. If the page asks the user to sign in, pause and let them complete sign-in. Click **Create**.

After creation, Linear redirects to the app settings page. **Do NOT screenshot credential pages or attempt to scrape secrets.** Proceed to Step 4.

### Path B: Manual Guided Setup

Guide the user through manual creation:

> ### Create a Linear OAuth Application
>
> 1. Open this manifest-backed Linear app creation URL:
>
>    `<LINEAR_MANIFEST_URL>`
>
> 2. Sign in to Linear if prompted, then review the pre-filled settings:
>    - **Application name:** `<AGENT_NAME>`
>    - **Developer name:** `Self-hosted`
>    - **Developer URL:** `https://github.com/nexmoe/atmiko`
>    - **Redirect callback URLs:** `<ATMIKO_BASE_URL>/callback`
>    - **Webhook URL:** `<ATMIKO_BASE_URL>/linear-webhook`
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
grep -q '^LINEAR_CLIENT_ID=' ~/.atmiko/.env || echo 'LINEAR_CLIENT_ID=' >> ~/.atmiko/.env
grep -q '^LINEAR_CLIENT_SECRET=' ~/.atmiko/.env || echo 'LINEAR_CLIENT_SECRET=' >> ~/.atmiko/.env
grep -q '^LINEAR_WEBHOOK_SECRET=' ~/.atmiko/.env || echo 'LINEAR_WEBHOOK_SECRET=' >> ~/.atmiko/.env
```

### 4b. Open env file for editing

```bash
# macOS
code --new-window ~/.atmiko/.env 2>/dev/null || open -a TextEdit ~/.atmiko/.env
# Linux
code --new-window ~/.atmiko/.env 2>/dev/null || xdg-open ~/.atmiko/.env
```

### 4c. Guide the user

Tell the user:

> I've opened `~/.atmiko/.env`. You need to paste three values from your Linear app settings page:
>
> 1. **Client ID** — copy it and paste after `LINEAR_CLIENT_ID=`
> 2. **Client Secret** — click the copy button next to it (it's masked with dots), paste after `LINEAR_CLIENT_SECRET=`
> 3. **Webhook Signing Secret** — click the copy button next to it, paste after `LINEAR_WEBHOOK_SECRET=`
>
> Save and close the file when done.

### 4d. Verify

After the user confirms they've saved:

```bash
grep -c '^LINEAR_CLIENT_ID=.' ~/.atmiko/.env
grep -c '^LINEAR_CLIENT_SECRET=.' ~/.atmiko/.env
grep -c '^LINEAR_WEBHOOK_SECRET=.' ~/.atmiko/.env
```

All three must return 1 (the `.` after `=` ensures the value is not empty). If any are 0, ask the user to check the file.

## Step 5: Authorize with Linear

Run the OAuth authorization flow:

```bash
node "$ATMIKO_ENTRY" self-auth-linear
```

This will:
1. Start a temporary OAuth callback server
2. Open the browser to Linear's authorization page
3. After the user clicks **Authorize**, save tokens to `~/.atmiko/config.json`

Verify authorization succeeded:

```bash
cat ~/.atmiko/config.json | grep -c '"workspaces"'
```

If the count is 0, authorization failed. Ask the user to check their credentials and try again.

## Completion

> ✓ Linear OAuth application created
> ✓ Credentials saved to `~/.atmiko/.env`
> ✓ Workspace authorized via the verified fork launcher.
