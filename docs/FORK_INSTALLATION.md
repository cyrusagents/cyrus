# Install the mikoagents/miko fork

`npx skills add mikoagents/miko -g` installs agent skills. Running `/miko-setup` then installs the runtime using the helper bundled with `miko-setup-prerequisites`. The source launcher uses the built workspace packages.

The source ref is recorded in [`source.json`](../skills/miko-setup-prerequisites/scripts/source.json) and defaults to `main`. Each install resolves it to an exact commit, builds with the pinned pnpm version and frozen lockfile, then records that commit in the installation metadata. Use `--ref <commit>` to reproduce a specific release. This installation flow does not publish an npm package.

## Requirements and installation

Use Node.js 22 or newer with npm/npx and Git. Windows also needs Git Bash from Git for Windows, because workspace build scripts use Unix file commands. The installer discovers its location; set `MIKO_BUILD_SHELL` to the absolute `bash.exe` path only for a nonstandard layout. Integration-specific requirements such as `gh`, `jq` and a coding engine are checked separately by setup.

The setup agent resolves the installed skill directory and runs:

```bash
node "<miko-setup-prerequisites>/scripts/install-fork.mjs"
```

For manual setup, get the installer from this checkout:

```bash
git clone --branch main --depth 1 https://github.com/mikoagents/miko.git miko-installer
node miko-installer/skills/miko-setup-prerequisites/scripts/install-fork.mjs
```

To select a directory, add `--install-dir "<absolute path>"`. Use the same directory on subsequent installs.

Default locations:

| Platform | Source installation |
| --- | --- |
| Windows | `%LOCALAPPDATA%/Miko` |
| macOS/Linux | `~/.local/share/miko` |

The installer fetches the selected source, uses its exact pnpm version through npx, installs the frozen lockfile, and builds the CLI plus its workspace dependencies. Each build has a separate release directory. It checks the CLI entry point, board assets, and that `miko-core` and `miko-edge-worker` resolve inside that release. It then activates the build through `current.json` and prints the stable `miko.mjs` launcher path.

Credentials, configuration, repository worktrees and board history remain in the existing Miko home, normally `~/.miko`. The installer neither starts a worker nor rewrites an existing service, global command, or user configuration.

## Verify and run

Set `MIKO_ENTRY` to the printed launcher path:

```bash
# Bash, with the default install directory
MIKO_ENTRY="$HOME/.local/share/miko/miko.mjs"
node "$MIKO_ENTRY" --installation
node "$MIKO_ENTRY" --version
```

```powershell
# PowerShell, with the default install directory
$MIKO_ENTRY = Join-Path $env:LOCALAPPDATA 'Miko/miko.mjs'
node "$MIKO_ENTRY" --installation
node "$MIKO_ENTRY" --version
```

`--installation` reports the fork URL, resolved commit, checkout, CLI entry point, and resolved worker/core paths. Verify the repository and commit against the pin or your chosen ref. The ordinary CLI version remains the upstream package version, so `--version` alone is insufficient.

Use the same launcher for subsequent commands:

```bash
node "$MIKO_ENTRY" self-auth-linear
node "$MIKO_ENTRY" self-add-repo https://github.com/yourorg/yourrepo.git
node "$MIKO_ENTRY" start
```

For `start` (including the default command), the launcher supervises a child worker, forwards shutdown signals, and coordinates automatic updates over a private IPC channel. Authentication, `--version`, and other one-shot commands still run directly and never check for updates. Pass normal options such as `--miko-home` or `--env-file` through the launcher. Once configured and running, `/status`, `/board`, and `/board/api/snapshot` are on the existing application port (3456 by default). Confirm your service command uses this launcher; a response from an older worker already occupying that port does not verify the new install. Only one managed worker may run per installation directory.

For pm2, use `pm2 start "<MIKO_ENTRY>" --name miko --interpreter "<absolute Node path>" -- start`. For systemd or a Windows background task, use the absolute Node and launcher paths with `start`. Preserve existing environment and tunnel settings. Wait for an existing worker to become idle and stop it gracefully before switching the service command.

## Automatic updates

New default source installations follow the `main` branch of `mikoagents/miko` automatically. Keep using the stable installed launcher (or a `miko` wrapper pointing to it), including in launchd, pm2, systemd, or a Windows background task. Running a development checkout's `app.js` directly does not enable automatic updates.

After startup, Miko waits roughly one to two minutes before its first check, then checks every six hours. The last check is persisted so service restarts do not repeatedly hit GitHub. Network or build failures are retried after fifteen minutes. Checks use the exact remote branch commit, not the npm package version.

Updates build in an isolated release directory while the current worker keeps serving tasks. After verification, the launcher waits for an idle worker. The worker checks running agents, queued work, webhook processing and scheduled-task dispatches, then stops admitting new HTTP requests and pauses scheduling before gracefully saving state and exiting. New requests during this short restart receive HTTP 503 with a retry hint. An update never force-stops an active task; a continuously busy instance waits until it becomes idle.

The candidate must report readiness within two minutes and stay running for thirty seconds. It keeps task admission and scheduling paused during this check, then reopens them after the launcher commits the version switch. If startup fails, the launcher restores the previous version and starts it again. Interrupted activation is also recovered on the next launch. A failed startup commit is skipped for 24 hours; a different branch head can be tried sooner. The current and previous releases are retained; older verified releases are cleaned up after activation. Config, credentials, worktrees and history are not replaced. Rollback covers program files and bundled skills, not arbitrary future data migrations.

Default skills record a content baseline. Unmodified defaults follow the installed version, including when rolling back. Edited skills, extra files, user-created symlinks and intentional deletions are preserved. Legacy copies without a baseline are compared against the previous installed release when available; unmatched content is kept. User skills in `~/.miko/user-skills-plugin/` are untouched.

Optional controls:

- Set `MIKO_AUTO_UPDATE=false` in the service environment or Miko's `.env` and restart to disable checks.
- Install with `--disable-auto-update` to disable updates in installation metadata.
- `--ref <commit-or-other-ref>` pins the selected version by default; `--update-ref <branch>` explicitly enables following that branch. The default `--ref main` follows `main`.
- Inspect the selected commit with `node "<launcher>" --installation`. Check `update-state.json` in the installation directory and `[AutoUpdate]` service logs for progress or failures.

Node.js, Git, npm/npx, build tools and network access must remain available to the background service. These prerequisites and the operating system are not upgraded automatically.

## Upgrade an existing installation or recover manually

Older installations cannot acquire the updater by restarting: update the setup skills and run their installer once, then restart the service through the installed launcher. Future updates are automatic. Existing Atmiko/Cyrus installations should first follow the [Miko migration guide](./MIKO_MIGRATION.md).

Running the installer again reuses a verified installation of the same immutable commit. To intentionally select another source version:

```bash
node "<miko-setup-prerequisites>/scripts/install-fork.mjs" --ref <commit-or-branch> --install-dir "<installation directory>"
```

Branch names are fetched and resolved to a commit each time. Installation requires the board and archive build artifacts; it will not silently substitute an older official package if they are missing. Fetch/build/verification failure leaves the previous runtime selected. Failed checkout paths are printed for diagnosis. New builds do not modify the running release; restart the configured service after successful installation when it is idle.

`current.json` identifies the active build; `previous.json` preserves the prior pointer. For a manual rollback, stop the service, set `MIKO_AUTO_UPDATE=false`, replace `current.json` with `previous.json`, clear any interrupted `update-state.json` and `pending.json`, verify `--installation`, and restart through the same launcher. The normal automatic path performs rollback without user intervention.

A killed installer may leave `install.lock` containing its PID. The next attempt reclaims it only when that process has definitely exited; unknown or live locks are left alone. Manual installs and automatic activation share this lock. Downloading setup skills alone does not upgrade an old runtime; it must first be installed through the updated installer.
