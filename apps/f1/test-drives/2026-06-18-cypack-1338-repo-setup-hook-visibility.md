# Test Drive: CYPACK-1338 Repo Setup Hook Visibility

**Date**: 2026-06-18  
**Goal**: Validate that repository `cyrus-setup.sh` execution is visible in the Linear agent-session activity stream, including start, success/failure, duration, bounded output, and redaction.  
**Test Repo**: `/private/tmp/f1-cypack-1338-setup-hook`

## Verification Results

### Issue-Tracker
- [x] Issue created: `DEF-1` for failing setup hook
- [x] Issue created: `DEF-2` for successful setup hook
- [x] Sessions created: `session-1`, `session-2`
- [x] Repository selection prompt and response worked in CLI issue tracker

### EdgeWorker
- [x] Session startup reached repository worktree creation
- [x] Repository `cyrus-setup.sh` was discovered from the issue worktree
- [x] Setup hook start activity appeared before routing and runner work
- [x] Setup hook failure did not block the agent session
- [x] Setup hook success activity included duration
- [x] Service logs still received raw hook stdout/stderr while Linear activities received redacted tails

### Renderer
- [x] Activity type was `action` with `action: "cyrus-setup.sh"`
- [x] Failure activity showed exit code and stdout/stderr tails
- [x] Failure activity redacted `SECRET_TOKEN=super-secret-value`
- [x] Failure activity redacted `Bearer abcdefghijklmnopqrstuvwxyz123456`
- [x] Failure activity did not expose `/private/...` or `/var/folders/...` worktree paths
- [x] Pagination worked with `view-session --limit 2 --offset 0`

## Session Log

Setup:

```bash
apps/f1/f1 init-test-repo --path /private/tmp/f1-cypack-1338-setup-hook
CYRUS_PORT=3601 CYRUS_REPO_PATH=/private/tmp/f1-cypack-1338-setup-hook bun run apps/f1/server.ts
CYRUS_PORT=3601 apps/f1/f1 ping
CYRUS_PORT=3601 apps/f1/f1 status
```

Port `3600` was already in use, so this drive used `3601`.

Failure path:

```bash
CYRUS_PORT=3601 apps/f1/f1 create-issue \
  --title "Validate failing setup hook redaction" \
  --description "Trigger cyrus-setup.sh failure and verify setup activities are visible with redacted output."
CYRUS_PORT=3601 apps/f1/f1 start-session --issue-id issue-1
CYRUS_PORT=3601 apps/f1/f1 prompt-session \
  --session-id session-1 \
  --message "https://github.com/f1-test/primary-repo"
```

Raw setup activities from `session-1`:

```json
[
  {
    "id": "activity-4",
    "type": "action",
    "content": "{\"type\":\"action\",\"action\":\"cyrus-setup.sh\",\"parameter\":\"Repository setup hook for F1 Test Repository\",\"result\":\"Started.\"}"
  },
  {
    "id": "activity-5",
    "type": "action",
    "content": "{\"type\":\"action\",\"action\":\"cyrus-setup.sh\",\"parameter\":\"Repository setup hook for F1 Test Repository\",\"result\":\"Failed after 4ms: Script exited with code 7\\nExit code: 7\\n\\nStdout tail:\\n```\\nsetup booting for DEF-1\\nSECRET_TOKEN=[REDACTED]\\nworkspace path: [workspace]/config\\n```\\n\\nStderr tail:\\n```\\nstderr Bearer [REDACTED]\\n```\"}"
  }
]
```

Checks:

```text
containsSecret false
containsBearer false
containsPrivatePath false
```

Success path:

```bash
CYRUS_PORT=3601 apps/f1/f1 create-issue \
  --title "Validate successful setup hook visibility" \
  --description "Trigger cyrus-setup.sh success and verify setup activities are visible with duration."
CYRUS_PORT=3601 apps/f1/f1 start-session --issue-id issue-2
CYRUS_PORT=3601 apps/f1/f1 prompt-session \
  --session-id session-2 \
  --message "https://github.com/f1-test/primary-repo"
```

Raw setup activities from `session-2`:

```json
[
  {
    "id": "activity-35",
    "type": "action",
    "content": "{\"type\":\"action\",\"action\":\"cyrus-setup.sh\",\"parameter\":\"Repository setup hook for F1 Test Repository\",\"result\":\"Started.\"}"
  },
  {
    "id": "activity-36",
    "type": "action",
    "content": "{\"type\":\"action\",\"action\":\"cyrus-setup.sh\",\"parameter\":\"Repository setup hook for F1 Test Repository\",\"result\":\"Succeeded in 2ms.\"}"
  }
]
```

Pagination:

```bash
CYRUS_PORT=3601 apps/f1/f1 view-session --session-id session-2 --limit 2 --offset 0
```

Result: displayed 2 of 13 activities and reported pagination guidance.

## Final Retrospective

Pass. The end-to-end F1 flow shows repository setup hook lifecycle activities in the agent session before normal runner work. Failure output is concise and redacted, while raw stdout/stderr remains available in service logs. The initial F1 run exposed a macOS path-alias redaction gap (`/private[workspace]/config`), which was fixed and covered by a regression test before rerunning the drive successfully.
