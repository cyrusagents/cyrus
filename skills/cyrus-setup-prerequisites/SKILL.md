---
name: cyrus-setup-prerequisites
description: Install the nexmoe/cyrus fork from a pinned source commit, verify its workspace packages and status board, and provide the launcher used by the remaining setup steps.
---

**CRITICAL: Never use `Read`, `Edit`, or `Write` tools on `~/.cyrus/.env` or any file inside `~/.cyrus/`. Use only `Bash` commands (`grep`, `printf >>`, etc.) to interact with env files — secrets must never be read into the conversation context.**

# Setup Prerequisites

Checks system prerequisites and builds the nexmoe/cyrus fork. This skill includes its installer under `scripts/`; run that copy even when the skills were installed without a Git checkout.

## Step 1: Select the Fork Build

Use the tested source commit in [scripts/source.json](scripts/source.json). It includes the integrated `/board` and persistent task history. The installer reads the pinned pnpm version from that source checkout and uses npm's `npx` to run it; a globally installed pnpm is not required.

Preserve any package-manager preference for unrelated tools, but use the locked pnpm workspace build for Cyrus. An existing global `cyrus` command or matching npm version is not proof that this fork is installed.

## Step 2: Check System Dependencies

Run the following checks and report results:

```bash
# Node.js >= 22, with npm/npx
node --version
npm --version
git --version

# jq (required for Claude Code parsing)
jq --version

# GitHub CLI (required for GitHub integration)
gh --version
```

For each missing dependency, provide the install command:

| Dependency | macOS | Linux/Ubuntu |
|-----------|-------|--------------|
| Node.js | `brew install node` | `curl -fsSL https://deb.nodesource.com/setup_22.x \| sudo -E bash - && sudo apt install -y nodejs` |
| jq | `brew install jq` | `sudo apt install -y jq` |
| gh | `brew install gh` | See https://github.com/cli/cli/blob/trunk/docs/install_linux.md |

If all dependencies are present, print a checkmark for each and continue.

On Windows, use Git for Windows with Git Bash: repository build scripts use `cp` and `rm`. The installer discovers Git Bash from `git --exec-path`; `CYRUS_BUILD_SHELL` can specify its absolute `bash.exe` path if the layout differs. Use the equivalent PowerShell checks on Windows.

If any are missing, offer to install them (detect OS via `uname`). Wait for user confirmation before installing.

## Step 3: Check for agent-browser (Optional)

If the user selected any integration surface (Linear, GitHub, Slack), check for `agent-browser`:

```bash
which agent-browser
```

**If installed**, ensure it's up to date:

```bash
npm update -g agent-browser
```

**If not found**, inform the user:

> `agent-browser` is optional but enables automated app creation for Linear/GitHub/Slack. Without it, you'll be guided through manual setup steps instead.
>
> Install with: `npm install -g agent-browser`

Do NOT block on this — it's optional. Note whether it's available for downstream skills.

## Step 4: Install the Fork

Resolve this skill's actual directory and run its bundled installer:

```bash
node "<absolute-path-to-this-skill>/scripts/install-fork.mjs"
```

The default install directory is `%LOCALAPPDATA%/Cyrus/nexmoe` on Windows and `~/.local/share/cyrus-nexmoe` on macOS/Linux. It is separate from `~/.cyrus`, which retains credentials, repositories and history. For a user-selected directory, pass `--install-dir "<directory>"` on every install/update.

The installer fetches the pinned commit, installs the frozen lockfile, builds the CLI and its workspace dependencies, verifies that `cyrus-edge-worker` and `cyrus-core` resolve inside this source release, and checks the board assets. It activates the release only after these checks succeed. It does not install the official npm package, overwrite global commands, or restart an existing worker.

Keep the printed launcher path as `CYRUS_ENTRY` for all remaining steps. For example, set `$CYRUS_ENTRY = '<printed path>'` in PowerShell or `CYRUS_ENTRY='<printed path>'` in Bash. Use `node "$CYRUS_ENTRY"` for **every Cyrus CLI call**, including authentication, repository setup and service startup. Pass this path to each sub-skill; do not fall back to a bare `cyrus` command.

Verify installation:

```bash
node "$CYRUS_ENTRY" --installation
node "$CYRUS_ENTRY" --version
```

Check that the reported repository is `https://github.com/nexmoe/cyrus.git` and the commit matches `scripts/source.json` (or the user's explicitly chosen `--ref`). The npm version alone cannot distinguish the fork.

If installation fails, retain the printed checkout for diagnosis and fix the build; do not substitute `npm install -g cyrus-ai`. A previous installation remains selected on fetch/build failure. An interrupted install may leave `install.lock`; verify that its recorded process has exited before removing only that lock file. Never rebuild or delete a source release currently used by a worker.

For an intentional update to a different commit/branch, rerun with `--ref <ref>`. The resolved commit is recorded in `current.json`, and the prior pointer is saved as `previous.json`. Restart an existing service only after it is idle, using the launcher in Step 8. No release is deleted automatically.

## Step 5: Ensure ~/.cyrus directory exists

```bash
mkdir -p ~/.cyrus
```

If `~/.cyrus/.env` already exists, note it and inform the user that existing values will be preserved.

## Completion

Print a summary:

```
Prerequisites:
  ✓ Node.js v22.x
  ✓ jq 1.7
  ✓ gh 2.x
  ✓ nexmoe/cyrus source commit verified
  ✓ Fork launcher: <CYRUS_ENTRY>
  ✓ agent-browser available (or: ⚠ not installed — manual setup mode)
```
