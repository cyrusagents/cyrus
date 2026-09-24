---
name: f1-test-drive
description: Assess F1 applicability, then validate changed product workflows or the F1 harness end-to-end. Skip drives and reports when no relevant workflow behavior changes.
---

# F1 Test Drive

## Applicability (required before setup)

This is the canonical F1 applicability policy. Inspect the actual diff against the
PR base and identify the behavior that needs validation before starting F1,
selecting a fixture, or creating a report. Task size, issue labels, filenames,
and a generic request to verify/ship are not sufficient reasons to run F1.

- **Required:** product/runtime changes exercised by F1 (issue tracking,
  authentication, routing, runner/session lifecycle, activity rendering), and
  functional changes to the F1 harness itself. Choose scenarios with assertions
  that exercise the changed behavior; a generic health check or unrelated
  fixture does not establish correctness.
- **Not applicable:** documentation, agent instructions, CI/release tooling,
  installer/build/packaging metadata, or other changes with no relevant product
  workflow behavior. Run appropriate documentation, script, unit, integration,
  build, package inspection, or isolated install smoke checks instead. Do not
  run F1 or create, attach, or commit an F1 test-drive report. A brief PR note
  stating why F1 is not applicable and what checks passed is enough.
- **Mixed changes:** exercise only the relevant functional portion with F1;
  validate other portions with their targeted checks. A docs, infrastructure,
  or metadata path is never an exemption for a real runtime behavior change
  (including dependencies, generated prompts, or installed defaults).
- **Actual releases:** assess the entire released payload against the previous
  release, not merely the version-bump PR. Runtime-bearing payloads retain
  relevant F1 validation. Payloads with no F1-covered behavior change use the
  non-F1 release verification described in `apps/cli/RELEASING.md`. Editing
  release tooling is not itself preparing or publishing a functional release.

If F1 is not applicable, stop this protocol before setup and reporting. If it
is applicable but blocked, report the missing coverage and blocker honestly;
do not relabel it as not applicable or substitute an unrelated passing drive.
Preserve historical reports.

| Actual change | Validation choice |
| --- | --- |
| PR #1502 artifact workflow and isolated installer tooling, without the separate agent-identity feature | Workflow/script tests, bundle integrity, isolated install and CLI smoke checks; no unrelated identity F1 fixture or report. |
| README wording or instruction-only policy such as CYPACK-1537 | Review consistency, links, and policy examples; no F1 report. Release-validator edits use proportionate verification; retain tests for consequential evidence-acceptance failures. |
| Runtime routing fix plus documentation | F1 scenario asserting changed routing; documentation checks for the rest. |
| EdgeWorker auth, routing, or session lifecycle | Relevant F1 scenarios asserting identity isolation, selected repository, or session continuation/termination as changed. |
| F1 RPC command, fixture execution, or activity renderer behavior | Exercise the changed harness path end-to-end and its unit/integration tests. Editing only F1 documentation still uses documentation checks. |
| Release PR changing only versions but shipping an unreleased session fix | Assess since the previous release; run relevant session F1 validation. |
| Release shipping only infrastructure/docs changes with no relevant workflow behavior | Record payload assessment and targeted checks as non-F1 release verification; no artificial F1 report. |

## Mission (when applicable)

Validate the changed workflow through the relevant issue-tracker, EdgeWorker,
and activity output paths. Name the scenario, expected behavior, and assertions
before setup. Use the phases below as building blocks; include only paths needed
for that scenario, plus setup and cleanup.

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

### Phase 3.5: Slack Chat Session Verification (optional)

Use when validating the Slack → ChatSessionHandler → ClaudeRunner path. F1 exposes a test-only endpoint `/cli/dispatch-chat` that injects a synthetic `app_mention` event without going through Slack signature verification (`SlackChatAdapter` no-ops Slack API calls when `slackBotToken` is undefined).

1. Dispatch a synthetic chat event:
   ```bash
   CYRUS_PORT=3600 ./f1 start-chat-session \
     --channel C_TEST_CHAN \
     --user U_TEST_USER \
     --text "hello"
   ```
   The response contains a `threadKey` of the form `<channel>:<ts>`. Reuse the same `--thread-ts` to address the same chat thread on subsequent dispatches.

2. Verify shared auto-memory wiring:
   - The chat workspace exists at `<cyrusHome>/slack-workspaces/<sanitized-threadKey>/`.
   - The shared auto-memory directory exists (or is lazily creatable) at `<cyrusHome>/slack-memory/`.
   - The `claude_query_options` event emitted by `ClaudeRunner` carries `cqo.settingsAutoMemoryDirectory=<cyrusHome>/slack-memory`.

3. Verify per-thread workspace isolation alongside shared memory:
   - Dispatch a second event in a different channel/thread.
   - Confirm a separate `slack-workspaces/<other-thread-key>/` directory exists (workspaces remain isolated).
   - Confirm both dispatches' telemetry resolve to the **same** `slack-memory` path (memory is shared).

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

Only after an applicable F1 drive, write a report under `apps/f1/test-drives/`.
Record the tested commit, changed behavior, commands, assertions, results, and
limitations. Adapt this template to the relevant scenario; omit unrelated
checklists. Never create a placeholder or “not applicable” F1 report:

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

Pass only when the changed-behavior assertions pass, along with the applicable
workflow checks below:

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
- For functional runner/harness changes, validate the affected path end-to-end before merge, as required by the applicability policy above.

## Multi-Harness Note

This skill is intentionally harness-agnostic:

- Claude subagents can call this skill.
- Codex/OpenCode workflows can reference the same skill content.
- Harness-specific adapters should be thin wrappers around this canonical skill.
