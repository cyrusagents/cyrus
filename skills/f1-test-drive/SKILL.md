---
name: f1-test-drive
description: Orchestrate F1 test drives to validate the Cyrus agent system end-to-end across issue-tracker, EdgeWorker, and activity rendering.
---

# F1 Test Drive

Run comprehensive F1 test drives that validate the full pipeline:

- Issue-tracker behavior
- EdgeWorker execution flow
- Activity rendering/output quality

## Mission

Execute test drives that verify:

1. Issue-tracker correctness
2. EdgeWorker worktree/session behavior
3. Activity output visibility and formatting

## Test Drive Protocol

### Phase 1: Setup

1. Create a fresh test repository (if needed):
   ```bash
   cd apps/f1
   ./f1 init-test-repo --path /tmp/f1-test-drive-<timestamp>
   ```

2. Start F1 server:
   ```bash
   CYRUS_PORT=3600 CYRUS_REPO_PATH=/tmp/f1-test-drive-<timestamp> bun run apps/f1/server.ts &
   ```

3. Verify server health:
   ```bash
   CYRUS_PORT=3600 ./f1 ping
   CYRUS_PORT=3600 ./f1 status
   ```

### Phase 2: Issue-Tracker Verification

1. Create test issue:
   ```bash
   CYRUS_PORT=3600 ./f1 create-issue \
     --title "<issue title>" \
     --description "<issue description>"
   ```

2. Verify issue ID and issue creation response.

### Phase 3: EdgeWorker Verification

1. Start agent session:
   ```bash
   CYRUS_PORT=3600 ./f1 start-session --issue-id <issue-id>
   ```

2. Monitor activities:
   ```bash
   CYRUS_PORT=3600 ./f1 view-session --session-id <session-id>
   ```

3. Verify:
   - session started
   - activities appear
   - agent is processing issue

### Phase 4: Renderer Verification

1. Validate activity payload quality:
   - expected types (for example `thought`, `action`, `response`)
   - timestamps present
   - content well-formed and readable

2. Validate pagination behavior:
   ```bash
   CYRUS_PORT=3600 ./f1 view-session --session-id <session-id> --limit 10 --offset 0
   ```

### Phase 5: Cleanup

1. Stop active session:
   ```bash
   CYRUS_PORT=3600 ./f1 stop-session --session-id <session-id>
   ```

2. Stop background server process.

## Reporting Format

Write report under `apps/f1/test-drives/`:

```markdown
# Test Drive #NNN: [Goal Description]

**Date**: YYYY-MM-DD
**Goal**: [One sentence]
**Test Repo**: [Path]

## Verification Results

### Issue-Tracker
- [ ] Issue created
- [ ] Issue ID returned
- [ ] Issue metadata accessible

### EdgeWorker
- [ ] Session started
- [ ] Worktree created (if applicable)
- [ ] Activities tracked
- [ ] Agent processed issue

### Renderer
- [ ] Activity format correct
- [ ] Pagination works
- [ ] Search works

## Session Log
[commands + key outputs + pass/fail]

## Final Retrospective
[what worked, issues, recommendations]
```

## Pass/Fail Criteria

Pass when:

1. Server starts
2. Issue created successfully
3. Session starts and activities appear
4. Activity payloads are coherent
5. Session stops cleanly
6. No unhandled errors

Fail when:

- server startup fails
- issue creation fails
- session does not start
- no activities after reasonable wait
- malformed activity data
- unhandled exceptions

## Important Notes

- Prefer fixed port `3600` unless already in use.
- Use fresh test repos per drive.
- Preserve failed state when debugging.
- For major runner/harness changes, run at least one F1 end-to-end validation before merge.

## Multi-Harness Note

This skill is intentionally harness-agnostic:

- Claude subagents can call this skill.
- Codex/OpenCode workflows can reference the same skill content.
- Harness-specific adapters should be thin wrappers around this canonical skill.
