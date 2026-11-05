# Plane

Cyrus can take work from [Plane](https://plane.so) (cloud or self-hosted Commercial Edition, including its free plan). Assign the Cyrus app to a work item and it works the whole item, like a Linear delegation; mention it in a comment to ask or instruct it, like a Linear @mention. It posts its progress to the agent run and answers follow-up replies in the run's thread.

Plane's agent apps are in beta, and the self-hosted Community Edition does not include them. Tested against self-hosted Plane Commercial v4.0.1.

## 1. Create the app in Plane

Workspace settings → Integrations → **Build your own**:

| Field | Value |
|---|---|
| Setup URL | `https://<cyrus-host>` |
| Redirect URI | `https://<cyrus-host>/plane-oauth/callback` |
| Webhook URL | `https://<cyrus-host>/plane-webhook` |
| Enable App Mentions | on |
| Scopes | `read`, `write`, the agent run scopes (`agents.runs:*`, `agents.run_activities:*`), and read for projects, states, labels, members and work items, plus write for work items and their comments |

The bot token request fails with `invalid_scope` until the app has scopes: Plane only grants the scopes listed on the app.

Save the **Client ID** and **Client Secret**, then install the app in the workspace. Plane redirects to `/plane-oauth/callback`; Cyrus saves the installation id to `<cyrus-home>/plane-installation.json`.

Installing creates a workspace webhook for the app (Workspace settings → Webhooks). It signs deliveries with its own secret (`X-Plane-Signature`, HMAC-SHA256 of the body); copy or regenerate it there for `PLANE_WEBHOOK_SECRET`. Plane wraps agent events in its webhook envelope (`{ event, action, data }`); Cyrus reads `data`.

## 2. Configure Cyrus

In `<cyrus-home>/.env`:

```bash
PLANE_BASE_URL=https://plane.example.com   # no trailing slash
PLANE_WORKSPACE_SLUG=acme
PLANE_CLIENT_ID=...
PLANE_CLIENT_SECRET=...
PLANE_WEBHOOK_SECRET=...                    # verifies X-Plane-Signature
# PLANE_APP_INSTALLATION_ID=...             # optional; otherwise taken from the install redirect
```

Restart Cyrus after changing these.

Each repository that should take Plane work uses the workspace key `plane-<workspace slug>` as its `linearWorkspaceId`, and is routed like a Linear repository. A Plane project counts as both the team (its identifier, e.g. `WEB`) and the project (its name):

```json
{
  "id": "web-frontend",
  "name": "web-frontend",
  "repositoryPath": "~/.cyrus/repos/web-frontend",
  "baseBranch": "master",
  "linearWorkspaceId": "plane-acme",
  "projectKeys": ["Web App"],
  "routingLabels": ["web-frontend"]
}
```

Give each Plane project the states your workflow uses; for example add an "In Review" state (group "started") if agents should move items there.

## What works

- Assignment starts a delegation (the whole work item, label-based procedures), and a mention starts a conversation on the mention comment. Plane sends two webhooks when a run starts; Cyrus starts one session and ignores Plane's generated assignment prompt.
- Thoughts, actions, responses, questions (including repository selection) and errors are posted to the agent run. Responses, questions and errors are sent as HTML converted from Markdown, so they render formatted in the thread.
- Sessions get a `plane` MCP server (`mcp__plane__*`) running as the app's bot: `get_work_item` (including the list of attached files), `download_attachments` (saves a work item's attachments into a directory, e.g. the worktree), `add_comment` (Markdown, with mentions), `add_link` (attaches a pull request or other link to the work item; the same URL again retitles it, e.g. "(merged)"), `list_states`, `set_state` and `list_members`. Its tools are allowed by default.
- Follow-up comments are fed into the running session; stopping the run in Plane stops Cyrus.
- The work item moves to the project's "started" state when work begins.
- A "Still working…" thought is posted after 4 silent minutes, so Plane doesn't mark a long run stale (it does after 5).
- Plane shows an agent's thoughts and actions only on paid plans, so while a run works the agent also keeps a reply in its thread ("Working on it." plus its latest thought, edited at most every 15 seconds) and deletes it when it answers, asks a question or fails.

## Not yet

- Images pasted into a work item's description: Plane's API only hands out attachments (the paperclip), so attach files the agent needs.
- Sub-issues and blocked-by relations of Plane work items.
- Stopping sessions when a work item is completed or cancelled in Plane.
- Some prompts still call the tracker "Linear"; tell the agent in your own instructions (e.g. `~/.claude/CLAUDE.md`) to use the `mcp__plane__*` tools for Plane work items.
