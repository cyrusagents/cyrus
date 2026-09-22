# Atmiko

<div>
  <a href="https://github.com/nexmoe/atmiko/actions">
    <img src="https://github.com/nexmoe/atmiko/actions/workflows/ci.yml/badge.svg" alt="CI">
  </a>

</div>

Your (Claude Code|Codex|Cursor|Gemini|Opencode) powered (Linear|GitHub|GitLab|Slack) agent. Atmiko monitors (Linear|GitHub|GitLab|Slack) issues assigned to it, creates isolated Git worktrees for each issue, runs (Claude Code|Codex|Cursor|Gemini|Opencode) sessions to process them, and streams detailed agent activity updates back to (Linear|GitHub), along with rich interactions like dropdown selects and approvals.

**Note:** Atmiko is a BYOK platform (bring your keys / subscriptions) for tokens.

---

## Getting Started

### Self-Hosted Setup

Host everything yourself with your own Linear OAuth app, GitHub App, and Slack App. An AI-guided setup skill handles the entire onboarding: installing dependencies, configuring auth, creating integration apps, and connecting repositories — so you don't have to follow a manual guide.

```bash
npx skills add nexmoe/atmiko -g
```

Then in any AI coding agent (Claude Code, Codex, Cursor, etc.):

```
/atmiko-setup
```

The skills install **Atmiko from source**, including `/board` and task history. `skills add` itself only downloads the setup skills; `/atmiko-setup` runs their bundled source installer. The runtime is built with the checkout's pinned pnpm version and frozen lockfile, with no dependency on a global `atmiko` installation.

See **[Fork Installation](./docs/FORK_INSTALLATION.md)** for requirements, the verified launcher, updates and source commit verification. The existing npm version number alone does not identify a fork build.

Or follow the **[manual setup guide](./docs/SELF_HOSTING.md)** if you prefer.

---

## More Documentation

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
