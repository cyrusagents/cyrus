# Move an existing installation to Miko

The project now lives at [mikoagents/miko](https://github.com/mikoagents/miko).
This is a breaking rename: old commands, paths, environment variables, and
integration endpoints are not aliases for the new names.

| Previous name | New name |
| --- | --- |
| `atmiko` | `miko` |
| `~/.atmiko` | `~/.miko` |
| `--atmiko-home` | `--miko-home` |
| `ATMIKO_*` | `MIKO_*` |
| `/atmiko-setup` and its sub-skills | `/miko-setup` and its sub-skills |
| `atmiko-setup.*`, `atmiko-teardown.*` | `miko-setup.*`, `miko-teardown.*` |
| `atmiko-*` workspace packages | `miko-*` workspace packages |
| `atmiko.mjs` source launcher | `miko.mjs` source launcher |
| `/api/update/atmiko-config`, `/api/update/atmiko-env` | `/api/update/miko-config`, `/api/update/miko-env` |
| `/mcp/atmiko-tools` | `/mcp/miko-tools` |

## Existing installations

1. Wait for active tasks to finish, then stop the worker and its service manager.
   Back up the configuration directory, repositories, worktrees, and history.
2. Install the new setup skills with `npx skills add mikoagents/miko -g`, then run
   `/miko-setup`, or follow the [source installation guide](FORK_INSTALLATION.md).
   New source installations use `~/.local/share/miko` on macOS/Linux or
   `%LOCALAPPDATA%/Miko` on Windows. Do not reuse old `current.json` metadata or
   assume that updating skills also updates the running worker.
3. Choose where to keep existing data. You can keep the directory in place and
   explicitly pass `--miko-home /absolute/path/to/existing/data` (or set
   `MIKO_HOME`), or move it to `~/.miko`. Miko does not discover the old path.
   Moving Git worktrees requires repairing their Git metadata; retaining their
   locations avoids breaking existing worktree links.
4. Rename `ATMIKO_` variable prefixes to `MIKO_` in the environment file, service
   definitions, container configuration, and secrets configured in CI. Other
   providers' credentials retain their names. Check absolute paths in
   `config.json`, MCP configuration, hooks, and environment values if data moved.
5. Rename repository setup/teardown scripts and update custom skill references,
   MCP tool allowlists (`mcp__miko-tools__...`), and clients using the renamed
   update endpoints. Custom config-update clients must use `restartMiko` in
   place of `restartAtmiko`.
6. Update the service to use the newly printed `miko.mjs` launcher, or the built
   `miko` command. Recreate GitHub credential helpers through repository setup
   if your Git configuration still points at the old helper script name.
7. Start Miko, check `/status` and `/board`, then submit a small task through a
   connected integration. Keep the backup until configuration and history have
   been verified. Avoid running both workers against the same integration.

Fresh installations can go directly to `/miko-setup`. The installer does not
move data, rewrite an existing service, or restart a worker automatically.
