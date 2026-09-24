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

The launcher imports the source CLI in the same process, preserving Miko's normal signal and shutdown handling. Pass normal options such as `--miko-home` or `--env-file` through it. Once configured and running, `/status`, `/board`, and `/board/api/snapshot` are on the existing application port (3456 by default). Confirm your service command uses this launcher; a response from an older worker already occupying that port does not verify the new install.

For pm2, use `pm2 start "<MIKO_ENTRY>" --name miko --interpreter "<absolute Node path>" -- start`. For systemd or a Windows background task, use the absolute Node and launcher paths with `start`. Preserve existing environment and tunnel settings. Wait for an existing worker to become idle and stop it gracefully before switching the service command.

## Update and recover

Running the installer again reuses a verified installation of the same immutable commit. To intentionally select another source version:

```bash
node "<miko-setup-prerequisites>/scripts/install-fork.mjs" --ref <commit-or-branch> --install-dir "<installation directory>"
```

Branch names are fetched and resolved to a commit each time. Installation requires the board and archive build artifacts; it will not silently substitute an older official package if they are missing. Fetch/build/verification failure leaves the previous runtime selected. Failed checkout paths are printed for diagnosis. New builds do not modify the running release; restart the configured service after successful installation when it is idle.

`current.json` identifies the active build; `previous.json` preserves the prior pointer. To roll back, gracefully stop the worker, replace `current.json` with `previous.json`, verify `--installation`, and restart through the same launcher. Keep old release directories while any process uses them. No release is deleted automatically.

A killed installer may leave `install.lock` containing its PID. Check that the installer has exited before removing that one lock file and retrying. Updating the skills does not automatically update a running Miko instance; rerun setup or the installer to apply the selected source version.
