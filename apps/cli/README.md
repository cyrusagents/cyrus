# Atmiko

Self-hosted development agent for Linear, GitHub, GitLab, Slack, and Zulip,
with Claude Code, Codex, Cursor, Gemini, and OpenCode runners.

## Installation

Install the setup skills, then run `/atmiko-setup` in your coding agent:

```bash
npx skills add nexmoe/atmiko -g
```

The setup builds the runtime from source and prints the `atmiko.mjs` launcher
path. See the [installation guide](https://github.com/nexmoe/atmiko/blob/main/docs/FORK_INSTALLATION.md)
for manual installation and commit verification.

## Usage

Use the launcher path printed by the installer:

```bash
node "<launcher-path>/atmiko.mjs" start
node "<launcher-path>/atmiko.mjs" self-auth-linear
node "<launcher-path>/atmiko.mjs" self-add-repo <git-url>
```

A built CLI exposes the `atmiko` command with these subcommands:

- `start` — start the worker (also the default command).
- `self-auth-linear` — authenticate using your own Linear OAuth app.
- `self-add-repo [url] [workspace]` — clone and configure a repository.
- `check-tokens` — inspect Linear token status.
- `refresh-token` — refresh a Linear token.

Atmiko stores configuration in `~/.atmiko`. Use `--atmiko-home <path>` to
select a different directory, or `--env-file <path>` for an environment file.
Open `/board` on the local server for tasks and logs. There is no paid-plan
login or default hosted-service connection.

## Configuration

### Environment Variables

- `ATMIKO_HOST_EXTERNAL` - Set to `true` to allow external connections (listens on `0.0.0.0` instead of `localhost`). Default: `false`
  - Use this when running in Docker containers or when you need external access to the webhook server
  - When `true`: Server listens on `0.0.0.0` (all interfaces)
  - When `false` or unset: Server listens on `localhost` (local access only)
- `LINEAR_ALLOWED_TOOLS` - Comma-separated list of tools allowed for Linear-triggered sessions. Overrides `linearAllowedTools` in `~/.atmiko/config.json` when set.
- `DISALLOWED_TOOLS` - Comma-separated list of tools disallowed across all sessions. Overrides `defaultDisallowedTools` in `~/.atmiko/config.json` when set.
