# Miko

Self-hosted development agent for Linear, GitHub, GitLab, Slack, and Zulip,
with Claude Code, Codex, Cursor, Gemini, and OpenCode runners.

## Installation

Install the setup skills, then run `/miko-setup` in your coding agent:

```bash
npx skills add mikoagents/miko -g
```

The setup builds the runtime from source and prints the `miko.mjs` launcher
path. See the [installation guide](https://github.com/mikoagents/miko/blob/main/docs/FORK_INSTALLATION.md)
for manual installation and commit verification.

## Usage

Use the launcher path printed by the installer:

```bash
node "<launcher-path>/miko.mjs" start
node "<launcher-path>/miko.mjs" self-auth-linear
node "<launcher-path>/miko.mjs" self-add-repo <git-url>
```

A built CLI exposes the `miko` command with these subcommands:

- `start` — start the worker (also the default command).
- `self-auth-linear` — authenticate using your own Linear OAuth app.
- `self-add-repo [url] [workspace]` — clone and configure a repository.
- `check-tokens` — inspect Linear token status.
- `refresh-token` — refresh a Linear token.

Miko stores configuration in `~/.miko`. Use `--miko-home <path>` to
select a different directory, or `--env-file <path>` for an environment file.
Open `/board` on the local server for tasks and logs. There is no paid-plan
login or default hosted-service connection.

## Configuration

### Environment Variables

- `MIKO_HOST_EXTERNAL` - Set to `true` to allow external connections (listens on `0.0.0.0` instead of `localhost`). Default: `false`
  - Use this when running in Docker containers or when you need external access to the webhook server
  - When `true`: Server listens on `0.0.0.0` (all interfaces)
  - When `false` or unset: Server listens on `localhost` (local access only)
- `LINEAR_ALLOWED_TOOLS` - Comma-separated list of tools allowed for Linear-triggered sessions. Overrides `linearAllowedTools` in `~/.miko/config.json` when set.
- `DISALLOWED_TOOLS` - Comma-separated list of tools disallowed across all sessions. Overrides `defaultDisallowedTools` in `~/.miko/config.json` when set.
