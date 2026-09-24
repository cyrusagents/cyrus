---
name: miko-setup
description: Set up Miko end-to-end — install prerequisites, configure authentication, create integrations (Linear, GitHub, Slack), add repositories, and launch. Run this once to get Miko running as a background agent.
---

# Miko Setup

One-command setup for self-hosted Miko. This orchestrator walks you through everything needed to run Claude Code as a background agent from Linear, Slack, and GitHub.

This fork builds **mikoagents/miko** from the source ref configured in the prerequisites skill. `skills add` installs these instructions and helper scripts; the prerequisites step installs the actual runtime. Keep its printed `MIKO_ENTRY` launcher path and pass it to every sub-skill. All Miko commands and persistent services must use `node "<MIKO_ENTRY>"`, including when another `miko` command already exists.

## CRITICAL Rules

### Never Read or Write ~/.miko/.env Directly

**FORBIDDEN:** Do NOT use `Read`, `Edit`, or `Write` tools on `~/.miko/.env` or any file inside `~/.miko/`. This file contains secrets (API keys, tokens, signing secrets). All interaction with this file MUST go through `Bash` commands (`grep`, `printf >> ...`, etc.) which the user can see and approve. Never read its contents into the conversation context.

### Browser Automation

The goal of browser automation in this skill is to **reduce sign-in and setup fatigue** — the agent navigates web UIs, fills forms, and scrapes credentials so the user doesn't have to do it all manually.

**Three modes, in order of preference:**

1. **`claude-in-chrome`** (preferred when available) — if the user is running Claude Code and has the `claude-in-chrome` MCP extension connected, use it. This has the huge advantage of using the user's existing Chrome with all their signed-in sessions (Linear, Slack, GitHub). Check availability by seeing if `mcp__claude-in-chrome__*` tools exist.
2. **`agent-browser` CLI** — a standalone Playwright-based binary invoked via `Bash`. Requires launching a **fresh Chrome profile** with remote debugging enabled (the user will need to sign in to services in that profile). Check with `which agent-browser`.
3. **Manual guided flow** — the user follows the agent's step-by-step instructions and does the clicks themselves. Always available as Path B in each sub-skill.

**Determining which mode to use:**

1. First, check if `claude-in-chrome` MCP tools are available in the current session. If yes, use those — no setup needed.
2. If not, check `which agent-browser`. If installed, launch a fresh Chrome profile (see below).
3. If neither is available, ask the user: install `agent-browser`, or follow manual instructions?

**`agent-browser` setup — fresh Chrome profile:**

`agent-browser` needs a Chrome instance with remote debugging enabled. Launch one with an isolated profile:

```bash
# Find an open port
for port in $(seq 9222 9322); do
  if ! lsof -i :"$port" > /dev/null 2>&1; then
    echo "Open port found: $port"
    break
  fi
done
```

```bash
# Create a fresh profile directory
mkdir -p ~/.miko/chrome-profile
```

```bash
# Launch Chrome with remote debugging (runs in background)
# macOS:
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=<port> \
  --user-data-dir="$HOME/.miko/chrome-profile" &

# Linux:
google-chrome --remote-debugging-port=<port> \
  --user-data-dir="$HOME/.miko/chrome-profile" &
```

```bash
# Connect agent-browser to it
agent-browser connect <port>
```

After connecting, commands work normally:

```bash
agent-browser navigate "https://example.com"
agent-browser click "button:text('Submit')"
agent-browser fill "#input-id" "value"
agent-browser screenshot
agent-browser eval "document.title"
```

**Important:** The user will need to **sign in to Linear, Slack, and GitHub** in this fresh Chrome profile before the agent can automate app creation. The agent should navigate to each service and pause for the user to sign in before proceeding with automation.

**Cleanup:** After setup is complete, close the Chrome instance:

```bash
lsof -ti :<port> | xargs kill 2>/dev/null
```

## How This Works

This skill runs sub-skills in order, skipping any that are already complete. You can re-run `/miko-setup` at any time to add integrations or fix configuration.

### Loading Sub-Skills

Each step references a sub-skill file. To execute a sub-skill, **read the SKILL.md file** using the `Read` tool and follow its instructions. The sub-skill files are sibling directories to this skill:

| Step | Sub-skill | File to read |
|------|-----------|-------------|
| 1 | setup-prerequisites | `miko-setup-prerequisites/SKILL.md` (relative to skills directory) |
| 2 | setup-claude-auth | `miko-setup-claude-auth/SKILL.md` |
| 3 | setup-endpoint | `miko-setup-endpoint/SKILL.md` |
| 4 | setup-linear | `miko-setup-linear/SKILL.md` |
| 5 | setup-github | `miko-setup-github/SKILL.md` |
| 5b | setup-gitlab | `miko-setup-gitlab/SKILL.md` |
| 6 | setup-slack | `miko-setup-slack/SKILL.md` |
| 7 | setup-repository | `miko-setup-repository/SKILL.md` |
| 8 | setup-launch | `miko-setup-launch/SKILL.md` |

To find the files, look for them relative to this file's directory (go up one level, then into the sub-skill directory). For example, if this file is at `~/.claude/skills/miko-setup/SKILL.md`, the sub-skills are at `~/.claude/skills/miko-setup-prerequisites/SKILL.md`, etc.

If a sub-skill file is not found, use `Glob` to search for it: `**/miko-setup-prerequisites/SKILL.md`

---

## Step 0: Identity & Surface Selection

Before anything else, collect preferences from the user. **Use the `AskUserQuestion` tool if available** — ask questions interactively rather than printing them as a text block. You may bundle related questions into a single ask, or ask them one at a time.

### Question 1: Name & Description

Ask the user (defaults in parentheses):

- **What would you like to name your agent?** — This name appears in Linear, Slack, and GitHub integrations. (default: `Miko`)
- **Give your agent a short description** — one sentence, shown in integration app listings. (default: `AI coding agent for automated development`)

Store as `AGENT_NAME` and `AGENT_DESCRIPTION` — used when creating Linear, Slack, and GitHub apps.

### Question 2: Which surfaces?

Ask the user to select one or more:

- **Linear** — issue tracking, recommended for most users
- **GitHub** — PR comments and issues
- **GitLab** — MR comments and issues
- **Slack** — chat messages

At least one is required. Store the selection — it determines which integration sub-skills run (Steps 4-6).

The Miko source build uses the pnpm version declared by its pinned checkout. Preserve any existing package-manager preference for installing unrelated tools.

---

## Step 1: Prerequisites

**Read** the `miko-setup-prerequisites/SKILL.md` sub-skill and follow its instructions.

Store the verified fork repository, commit and `MIKO_ENTRY` launcher path returned by this step. Do not skip it just because `which miko` succeeds.

---

## Step 2: Claude Auth

**Read** the `miko-setup-claude-auth/SKILL.md` sub-skill and follow its instructions.

---

## Step 3: Webhook Endpoint

**Read** the `miko-setup-endpoint/SKILL.md` sub-skill and follow its instructions.

---

## Step 4: Linear (if selected)

**Only if the user selected Linear in Step 0.**

**Read** the `miko-setup-linear/SKILL.md` sub-skill and follow its instructions.

---

## Step 5: GitHub (if selected)

**Only if the user selected GitHub in Step 0.**

**Read** the `miko-setup-github/SKILL.md` sub-skill and follow its instructions.

---

## Step 5b: GitLab (if selected)

**Only if the user selected GitLab in Step 0.**

**Read** the `miko-setup-gitlab/SKILL.md` sub-skill and follow its instructions.

---

## Step 6: Slack (if selected)

**Only if the user selected Slack in Step 0.**

**Read** the `miko-setup-slack/SKILL.md` sub-skill and follow its instructions. **All paths (A-1, A-2, and B) must use the manifest-based creation flow** — never create the Slack app "from scratch" with manual scope/event configuration.

---

## Step 7: Add Repositories

**Read** the `miko-setup-repository/SKILL.md` sub-skill and follow its instructions.

---

## Step 8: Launch

**Read** the `miko-setup-launch/SKILL.md` sub-skill and follow its instructions.

---

## Design Principles

1. **Skip-if-done** — Every sub-skill checks existing state first. Re-running `/setup` is safe.
2. **Secrets never enter chat** — Credentials are either scraped via agent-browser or written via clipboard-to-env shell commands the user runs in their terminal.
3. **Agent writes non-secret config** — Values like `MIKO_SERVER_PORT` and `LINEAR_DIRECT_WEBHOOKS` are written directly by the agent.
4. **Browser automation when available** — Uses `agent-browser` for Linear/Slack app creation; falls back to guided manual steps if not installed.
5. **Verified fork runtime** — Build the pinned source with its locked pnpm toolchain and use the resulting launcher throughout setup and service configuration.
