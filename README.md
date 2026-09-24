# Miko

<div>
  <a href="https://github.com/mikoagents/miko/actions">
    <img src="https://github.com/mikoagents/miko/actions/workflows/ci.yml/badge.svg" alt="CI">
  </a>

</div>

Miko is a self-hosted development agent for Linear, GitHub, GitLab, Slack, and Zulip. It works on tasks in isolated Git worktrees and sends progress and results back to your team. Choose Claude Code, Codex, Cursor, Gemini, OpenCode, or Grok as the coding engine.

Use your own API keys or coding-agent subscriptions.

---

## Getting Started

### Self-Hosted Setup

Host everything yourself with your own Linear OAuth app, GitHub App, and Slack App. An AI-guided setup skill handles the entire onboarding: installing dependencies, configuring auth, creating integration apps, and connecting repositories — so you don't have to follow a manual guide.

```bash
npx skills add mikoagents/miko -g
```

Then in any AI coding agent (Claude Code, Codex, Cursor, etc.):

```
/miko-setup
```

The skills install **Miko from source**, including `/board` and task history. `skills add` itself only downloads the setup skills; `/miko-setup` runs their bundled source installer. The runtime is built with the checkout's pinned pnpm version and frozen lockfile, with no dependency on a global `miko` installation.

### What to Expect

Running `/miko-setup` starts a guided conversation with your coding agent. It walks you through the following steps, checking existing configuration as it goes:

1. **Choose your agent's name and integrations.** Pick the services you want to use: Linear, GitHub, GitLab, or Slack. Setup only configures the integrations you select.
2. **Install Miko on your machine.** The agent checks prerequisites, helps you install missing tools, and downloads and builds Miko from source.
3. **Connect your coding credentials.** The default setup guides you through Claude Code authentication with your own API key, OAuth token, or supported provider account. Miko also supports other runners through its [configuration](./docs/CONFIG_FILE.md).
4. **Connect your chosen services.** Set up a public webhook URL using a tunnel or your own domain, then create and authorize the integration apps. The agent can help with browser steps or provide manual instructions; you sign in and approve access to your accounts.
5. **Add your repositories.** Choose the repositories Miko should work on. Setup clones them and saves Miko's settings under `~/.miko`.
6. **Start Miko and verify it works.** Review the setup summary, choose how to keep it running, and start the worker. The agent checks the local service and gives you the `/board` URL for tasks and logs.

**Try your first task:** assign a Linear issue to Miko, @mention it on a configured GitHub PR or GitLab MR, or mention the bot in Slack. It creates an isolated workspace for the task, runs the coding agent, and sends progress and results back to the connected service. Keep Miko running, along with any tunnel you use, so new tasks can reach it.

You can run `/miko-setup` again to add integrations or update your configuration.

See **[Fork Installation](./docs/FORK_INSTALLATION.md)** for requirements, the verified launcher, updates and source commit verification. The existing npm version number alone does not identify a fork build.

Or follow the **[manual setup guide](./docs/SELF_HOSTING.md)** if you prefer.

---

## More Documentation

- **[Migration to Miko](./docs/MIKO_MIGRATION.md)** - New names and how to move an existing installation
- **[Automations](./docs/AUTOMATIONS.md)** - Schedule repository tasks and inspect run history
- **[Local Status Board](./docs/STATUS_BOARD.md)** - Live tasks and searchable logs at `/board`, on the same server as `/status`
- **[Self-Hosting Guide](./docs/SELF_HOSTING.md)** - Complete community manual setup
- **[Git & GitHub Setup](./docs/GIT_GITHUB.md)** - Git and GitHub CLI configuration for PRs
- **[Git & GitLab Setup](./docs/GIT_GITLAB.md)** - Git and GitLab CLI configuration for MRs
- **[Zulip Setup](./docs/ZULIP.md)** - Answer @mentions in Zulip topics and DMs
- **[Configuration Reference](./docs/CONFIG_FILE.md)** - Detailed config.json options
- **[Cloudflare Tunnel Setup](./docs/CLOUDFLARE_TUNNEL.md)** - Expose your local instance
- **[Setup Scripts](./docs/SETUP_SCRIPTS.md)** - Repository and global initialization scripts

---

## License

This project is licensed under the Apache 2.0 license - see the [LICENSE](LICENSE) file for details.

## Credits

This project builds on the technologies built by the awesome teams at Linear, and Claude by Anthropic:

- [Linear API](https://linear.app/developers)
- [Anthropic Claude Code](https://www.claude.com/product/claude-code)
