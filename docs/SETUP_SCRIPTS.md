# Setup Scripts

Cyrus supports optional setup scripts that run automatically when creating new git worktrees for issues. This allows you to perform repository-specific or global initialization tasks.

---

## Repository Setup Script

Place a `cyrus-setup.sh` script in your repository root to run repository-specific initialization.

### How it works

1. Place a `cyrus-setup.sh` script in your repository root
2. When Cyrus processes an issue, it creates a new git worktree
3. Cyrus discovers the setup script from the newly-created issue worktree, so the script version matches the checked-out code for that task
4. If the setup script exists, Cyrus runs it in the new worktree with these environment variables:
   - `LINEAR_ISSUE_ID` - The Linear issue ID
   - `LINEAR_ISSUE_IDENTIFIER` - The issue identifier (e.g., "CEA-123")
   - `LINEAR_ISSUE_TITLE` - The issue title

### Example Usage

```bash
#!/bin/bash
# cyrus-setup.sh - Repository initialization script

# Copy environment files from a central location
cp /path/to/shared/.env packages/app/.env

# Install dependencies if needed
# npm install

# Set up test databases, copy config files, etc.
echo "Repository setup complete for issue: $LINEAR_ISSUE_IDENTIFIER"
```

Make sure the script is executable: `chmod +x cyrus-setup.sh`

---

## Global Setup Script

In addition to repository-specific scripts, you can configure a global setup script that runs for **all** repositories when creating new worktrees.

### Configuration

Add `global_setup_script` to your `~/.cyrus/config.json`:

```json
{
  "repositories": [...],
  "global_setup_script": "/opt/cyrus/bin/global-setup.sh"
}
```

### Execution Order

When creating a new worktree:

1. **Global script** runs first (if configured)
2. **Repository script** (`cyrus-setup.sh`) runs second (if exists)

Both scripts receive the same environment variables and run in the worktree directory. The global script path comes from Cyrus configuration; repository scripts are discovered from the issue worktree after checkout.

### Use Cases

- **Team-wide tooling** that applies to all repositories
- **Shared credential** setup
- **Common environment** configuration

Make sure the script is executable: `chmod +x /opt/cyrus/bin/global-setup.sh`

### Error Handling

- If the global script fails, Cyrus logs the error but continues with repository script execution
- Both scripts have a 5-minute timeout to prevent hanging
- Script failures don't prevent worktree creation

---

## Repository Teardown Script

Place a `cyrus-teardown.sh` script in your repository root to run repository-specific cleanup when an issue reaches a terminal state (completed, canceled, or deleted). Auto-detected from the issue worktree the same way as `cyrus-setup.sh` — no configuration needed.

### How it works

1. Place a `cyrus-teardown.sh` script in your repository root
2. When the Linear issue reaches a terminal state, Cyrus runs the script inside the issue's worktree directory, then removes the worktree
3. Only `LINEAR_ISSUE_IDENTIFIER` is guaranteed in the environment — the id and title are not available on the terminal-state cleanup path

### Multi-repo issues

For issues that span multiple repositories, each repo's `cyrus-teardown.sh` runs independently with `cwd` set to that repo's worktree subdirectory. Repos without a teardown script are silently skipped. A failure in one repo's teardown does not prevent the other repos' teardowns from running or block worktree removal.

### Example: identifier-based naming

```bash
#!/bin/bash
# cyrus-teardown.sh
slug="${LINEAR_ISSUE_IDENTIFIER//-/_}"
dropdb --if-exists "db_${slug}"
docker compose -p "cyrus_${slug}" down -v
```

### Example: breadcrumb file in the worktree

For resources whose names aren't naturally identifier-keyed (random container IDs, dynamically allocated ports), have setup leave a breadcrumb file inside the worktree. Teardown runs before the worktree is removed, so the file is still readable:

```bash
# cyrus-setup.sh
port=$(shuf -i 49152-65535 -n 1)
PROJECT="cyrus_${LINEAR_ISSUE_IDENTIFIER//-/_}"
docker compose -p "$PROJECT" up -d
printf '{"port": %d, "project": "%s"}\n' "$port" "$PROJECT" > .cyrus-cleanup.json
```

```bash
# cyrus-teardown.sh
[ -f .cyrus-cleanup.json ] || exit 0
project=$(jq -r .project .cyrus-cleanup.json)
docker compose -p "$project" down -v
```

### Idempotency

Cleanup may be retried, so write the script idempotently (`--if-exists`, `docker rm -f`, etc.).

### Error handling

- Teardown scripts have a **2-minute timeout**
- Script failures are logged but do not block worktree removal
- In multi-repo issues, one repo's teardown failure does not skip other repos' teardowns

Make sure the script is executable: `chmod +x cyrus-teardown.sh`
