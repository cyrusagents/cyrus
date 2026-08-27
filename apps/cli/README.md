# cyrus-ai

AI development agent for Linear powered by Claude Code.

## Installation

```bash
npm install -g cyrus-ai
```

## Usage

### Start the agent
```bash
cyrus
```

### Available Commands

- **`cyrus`** - Start the edge worker (default)
- **`cyrus add-repository`** - Add a new repository configuration
- **`cyrus check-tokens`** - Check the status of all Linear tokens
- **`cyrus refresh-token`** - Refresh a specific Linear token

### Adding Repositories

After initial setup, you can add additional repositories without restarting Cyrus:

```bash
cyrus add-repository
```

This command will:
1. Check for existing Linear credentials and reuse them if available
2. Start OAuth flow only if no credentials are found
3. Guide you through configuring the new repository
4. Save the updated configuration

The interactive wizard will prompt you for:
- Repository path (must be absolute)
- Base branch (defaults to 'main')
- Workspace directory for git worktrees
- Whether the repository is active

## Configuration

### Environment Variables

- `CYRUS_HOST_EXTERNAL` - Set to `true` when Cyrus is reachable from outside the machine, i.e. self-hosted with webhooks delivered directly rather than forwarded. Default: `false`
  - Use this when running in Docker containers or when you need external access to the webhook server
  - Selects direct (signature-verified) webhook handling instead of proxied, and turns on webhook source-IP validation by default
  - Also supplies the default bind address, which `CYRUS_SERVER_HOST` overrides: `0.0.0.0` (all interfaces) when `true`, `localhost` when `false` or unset
- `CYRUS_SERVER_HOST` - Address the server binds to. Default: derived from `CYRUS_HOST_EXTERNAL` as above
  - Set this when a tunnel or reverse proxy on the same host fronts Cyrus and nothing off-box needs to reach the port: `CYRUS_SERVER_HOST=127.0.0.1` with `CYRUS_HOST_EXTERNAL=true` binds loopback while keeping direct webhook verification and IP validation
  - Do not turn `CYRUS_HOST_EXTERNAL` off to move the bind address - that also switches webhook verification mode and disables IP validation
  - A non-loopback address requires `CYRUS_HOST_EXTERNAL=true`; without it Cyrus stays loopback-only and rejects the configuration at startup, since the port would otherwise be reachable from the network while webhooks are verified in proxy mode and source-IP validation is off by default
- `LINEAR_ALLOWED_TOOLS` - Comma-separated list of tools allowed for Linear-triggered sessions. Overrides `linearAllowedTools` in `~/.cyrus/config.json` when set.
- `DISALLOWED_TOOLS` - Comma-separated list of tools disallowed across all sessions. Overrides `defaultDisallowedTools` in `~/.cyrus/config.json` when set.