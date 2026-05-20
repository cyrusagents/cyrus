# Setup Scripts

Cyrus supports optional setup scripts that run automatically when creating new git worktrees for issues. This allows you to perform repository-specific or global initialization tasks.

---

## Repository Setup Script

Place a `cyrus-setup.sh` script in your repository root to run repository-specific initialization.

### How it works

1. Place a `cyrus-setup.sh` script in your repository root
2. When Cyrus processes an issue, it creates a new git worktree
3. If the setup script exists, Cyrus runs it in the new worktree with these environment variables:
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

Both scripts receive the same environment variables and run in the worktree directory.

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

## Global Teardown Script

You can also configure a teardown script that runs from inside the issue's worktree directory **immediately before the worktree is deleted**, when the issue reaches a terminal state.

### Configuration

Add `global_teardown_script` to your `~/.cyrus/config.json`:

```json
{
  "repositories": [...],
  "global_teardown_script": "/opt/cyrus/bin/global-teardown.sh"
}
```

### When it runs

The teardown script fires only when an issue reaches a terminal state:

- Linear issue moved to **completed**
- Linear issue moved to **canceled**
- Linear issue **deleted**

It does **not** fire on issue unassignment — re-assignment is a normal flow and Cyrus preserves the worktree (and any setup-script artifacts) so a re-assigned issue can resume work immediately.

### Environment

The teardown script receives **only**:

- `LINEAR_ISSUE_IDENTIFIER` — the issue identifier (e.g., `CEA-123`)

`LINEAR_ISSUE_ID` and `LINEAR_ISSUE_TITLE` are **not** available on the terminal-state cleanup path. Setup scripts receive all three; teardown scripts receive only the identifier. Do not reference fields that aren't set.

### Working directory

The script runs with the issue's worktree directory as its working directory, so it can read `.env.local`, local databases, or any other artifacts written by the setup script.

### Important behaviors

- **Idempotent.** Cleanup may be retried, so the script may run more than once for the same issue. Write your teardown so re-running it is safe.
- **Non-blocking on failure.** If the teardown script fails (non-zero exit, error, timeout, etc.), Cyrus logs the failure and proceeds with worktree deletion.
- **2-minute timeout.** Teardown is intended for lightweight cleanup; longer-running teardown will be killed.
- **`stdio: "inherit"`.** Anything the script echoes — including secrets — lands in the edge-worker logs.

### Example Usage

```bash
#!/bin/bash
# global-teardown.sh - Tear down per-issue resources
set -euo pipefail

# Identifier is the only env var available
echo "Tearing down resources for $LINEAR_ISSUE_IDENTIFIER"

# Idempotent cleanup — guard against re-runs
if [ -f .env.local ]; then
  # e.g., stop a per-issue Docker compose stack
  docker compose -f docker-compose.cyrus.yml down --volumes || true
fi
```

Make sure the script is executable: `chmod +x /opt/cyrus/bin/global-teardown.sh`
