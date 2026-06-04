# Test Drive: CYPACK-1287 — Codex managed skills discovery

**Date**: 2026-06-04
**Goal**: Verify Cyrus-managed user skills can be surfaced to the Codex runner.
**Test Repo**: `/tmp/f1-test-drive-cypack-1287`
**F1 Cyrus Home**: `/var/folders/xv/c55x22nd6lv8kq9fccch04d40000gp/T/cyrus-f1-1780601219391`

## Verification Results

### Issue-Tracker
- [x] Issue created (`issue-2`, `DEF-2`)
- [x] Issue ID returned
- [x] Labels routed the issue to `F1 Test Repository`

### EdgeWorker
- [x] Session started (`session-2`)
- [x] Worktree created at `.../worktrees/DEF-2`
- [x] Codex runner selected via `[agent=codex]`
- [x] User skills plugin resolved from F1 `cyrusHome`
- [x] Full Codex model turn started
- [ ] Full Codex model turn completed

### Codex Skill Discovery
- [x] Seeded managed user skill at `user-skills-plugin/skills/cypack-1287-canary/SKILL.md`
- [x] Built `CodexRunner.prepareManagedSkillsForCodex()` symlinked the skill into the Codex worktree's repository skill path
- [x] `codex debug prompt-input` listed `cypack-1287-canary` in the available-skills block with the expected `CANARY_SKILL_AVAILABLE` description
- [x] Staged skill directory was removed after the deterministic probe

## Session Log

Commands:

```bash
cd apps/f1
./f1 init-test-repo --path /tmp/f1-test-drive-cypack-1287
CYRUS_PORT=3600 CYRUS_REPO_PATH=/tmp/f1-test-drive-cypack-1287 bun run apps/f1/server.ts
CYRUS_PORT=3600 ./f1 ping
CYRUS_PORT=3600 ./f1 status
CYRUS_PORT=3600 ./f1 create-issue \
  --title "CYPACK-1287 Codex managed skill routed canary" \
  --description 'Use $cypack-1287-canary and then stop. [agent=codex]' \
  --labels codex,primary
CYRUS_PORT=3600 ./f1 start-session --issue-id issue-2
CYRUS_PORT=3600 ./f1 view-session --session-id session-2
```

Key outputs:

- F1 health returned `ready`.
- EdgeWorker logs showed label routing to `F1 Test Repository`.
- EdgeWorker logs showed `Using user skills plugin at .../user-skills-plugin`.
- EdgeWorker logs showed `Label-based runner selection for new session: codex`.
- Codex exec started but exited with code 1 before producing a response activity.

Deterministic Codex probe:

```bash
CodexRunner.prepareManagedSkillsForCodex()
codex debug prompt-input 'Use $cypack-1287-canary'
```

The rendered Codex prompt included:

```text
- cypack-1287-canary: Use when validating CYPACK-1287 Codex managed skill discovery; respond with CANARY_SKILL_AVAILABLE.
```

## Final Retrospective

The F1 pipeline validated issue creation, routing, worktree creation, Codex runner selection, and managed skill resolution. The live model turn did not complete because Codex exec exited with code 1 in this local F1 environment, so the end-to-end response assertion remains blocked.

The deterministic Codex prompt-input probe verifies the relevant discovery contract without a model call: after the runner symlinks the scoped managed skill under the worktree `.agents/skills` directory, Codex includes it as the unqualified local skill name available to the session.
