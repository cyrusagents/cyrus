# Cyrus

<div>
  <a href="https://github.com/ceedaragents/cyrus/actions">
    <img src="https://github.com/ceedaragents/cyrus/actions/workflows/ci.yml/badge.svg" alt="CI">
  </a>

</div>

[![Discord](https://img.shields.io/discord/1443747721910685792?label=Discord&logo=discord&logoColor=white)](https://discord.gg/prrtADHYTt)

Your (Claude Code|Codex|Cursor|Gemini) powered (Linear|GitHub|GitLab|Slack) agent. Cyrus monitors (Linear|GitHub|GitLab|Slack) issues assigned to it, creates isolated Git worktrees for each issue, runs (Claude Code|Codex|Cursor|Gemini) sessions to process them, and streams detailed agent activity updates back to (Linear|GitHub), along with rich interactions like dropdown selects and approvals.

**Note:** Cyrus is a BYOK platform (bring your keys / subscriptions) for tokens.

---

## Getting Started

### End-to-End Self-Hosted (Community)

Zero cost option — host everything yourself with your own Linear OAuth app, GitHub App, and Slack App. An AI-guided setup skill handles the entire onboarding: installing dependencies, configuring auth, creating integration apps, and connecting repositories — so you don't have to follow a manual guide.

```bash
npx skills add ceedaragents/cyrus -g
```

Then in any AI coding agent (Claude Code, Codex, Cursor, etc.):

```
/cyrus-setup
```

Or follow the **[manual setup guide](./docs/SELF_HOSTING.md)** if you prefer.

---

### Pro & Team Plans

Configure Cyrus through the dashboard at [app.atcyrus.com](https://app.atcyrus.com).

#### For paid self-hosted deployments

It is called 'self-hosted' because it uses a machine you control as the agent runtime. Networking layer and integrations are provided by the Cyrus cloud provider.

```bash
# Install Cyrus
npm install -g cyrus-ai

# Authenticate with your token (provided during onboarding)
cyrus auth <your-token>
```

For Cyrus to create pull requests or merge requests, configure Git and your hosting CLI. See **[Git & GitHub Setup](./docs/GIT_GITHUB.md)** or **[Git & GitLab Setup](./docs/GIT_GITLAB.md)**.

Keep Cyrus running as a persistent process:

- **tmux**: `tmux new -s cyrus` then run `cyrus` (Ctrl+B, D to detach)
- **pm2**: `pm2 start cyrus --name cyrus`
- **systemd**: See [Running as a Service](./docs/SELF_HOSTING.md#running-as-a-service)

#### For cloud-hosted deployments

No installation required. Everything is managed through [app.atcyrus.com](https://app.atcyrus.com).

---

## More Documentation

- **[End-to-End Community Guide](./docs/SELF_HOSTING.md)** - Complete community manual setup
- **[Git & GitHub Setup](./docs/GIT_GITHUB.md)** - Git and GitHub CLI configuration for PRs
- **[Git & GitLab Setup](./docs/GIT_GITLAB.md)** - Git and GitLab CLI configuration for MRs
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
