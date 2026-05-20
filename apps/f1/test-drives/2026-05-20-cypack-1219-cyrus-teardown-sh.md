# Test Drive: CYPACK-1219 — per-repo `cyrus-teardown.sh` auto-detection

**Date**: 2026-05-20
**Goal**: Validate the per-repo `cyrus-teardown.sh` feature end-to-end through F1, using the new `f1 terminate-issue` command to drive issues to a terminal state.
**Test Repo**: `/tmp/f1-td-<ts>-a` (single-repo F1 server, port 3602)
**F1 server**: `CYRUS_PORT=3602 CYRUS_REPO_PATH=/tmp/f1-td-<ts>-a bun run apps/f1/server.ts`

## Result

**All 8 scenarios passed.** Per-repo `cyrus-teardown.sh` fires end-to-end through the F1 framework on all three terminal actions (`completed` / `canceled` / `deleted`), with correct `cwd` and `LINEAR_ISSUE_IDENTIFIER`, runs before worktree removal, is non-blocking on failure, is skipped silently when absent, and is not triggered by `stop-session`.

## Setup

The test repo had two sentinel-writing scripts at its root, committed:

```bash
# /tmp/f1-td-.../cyrus-setup.sh
mkdir -p /tmp/cyrus-hooks
printf 'identifier=%s\ncwd=%s\nhook=setup\nrepo=%s\n' \
  "$LINEAR_ISSUE_IDENTIFIER" "$PWD" "<repo-basename>" \
  > "/tmp/cyrus-hooks/setup-$LINEAR_ISSUE_IDENTIFIER-<repo>.txt"
```

```bash
# /tmp/f1-td-.../cyrus-teardown.sh
mkdir -p /tmp/cyrus-hooks
printf 'identifier=%s\ncwd=%s\nhook=teardown\nrepo=%s\n' \
  "$LINEAR_ISSUE_IDENTIFIER" "$PWD" "<repo-basename>" \
  > "/tmp/cyrus-hooks/teardown-$LINEAR_ISSUE_IDENTIFIER-<repo>.txt"
```

Both `chmod +x`'d. F1 server started single-repo. Each scenario followed the same outer loop: `create-issue` → `start-session` → `prompt-session` (to satisfy repo-selection), then a per-scenario terminal action.

## Scenarios

### 1. `terminate-issue --action completed` → teardown fires

```
DEF-1: setup wrote setup-DEF-1-*.txt
terminate-issue --action completed
→ teardown-DEF-1-*.txt written with cwd=/private/tmp/cyrus-f1-.../worktrees/DEF-1
→ worktree directory removed
```

Server log:
```
[EdgeWorker] [MessageBus] Issue reached terminal state: DEF-1
[EdgeWorker] Stopping agent runner for DEF-1 (issue terminal)
[GitService] ℹ️  Running repository teardown script: cyrus-teardown.sh
[GitService] ✅ Repository teardown script completed successfully
```

✅ Pass.

### 2. `terminate-issue --action canceled` → teardown fires identically

```
DEF-2: setup + canceled action
→ teardown-DEF-2-*.txt written with correct cwd
→ worktree removed
```

✅ Pass.

### 3. `terminate-issue --action deleted` → teardown fires + issue removed

```
DEF-3: setup + deleted action
→ teardown-DEF-3-*.txt written
→ worktree removed
→ issue removed from in-memory state (would 404 on subsequent fetch)
```

✅ Pass.

### 4. No `cyrus-teardown.sh` present → no teardown attempt, worktree still removed

Renamed `cyrus-teardown.sh` aside, then:

```
DEF-4: setup ran, no teardown script present
terminate-issue --action completed
→ /tmp/cyrus-hooks/ contains setup-DEF-4 but NO teardown-DEF-4
→ worktree directory removed cleanly
```

Server log shows direct deletion without a teardown invocation:
```
[GitService] Deleting worktree directory for DEF-4 at .../worktrees/DEF-4
[GitService] Removing git worktree: .../worktrees/DEF-4
[GitService] Deleted worktree directory for DEF-4
```

✅ Pass — absent script is silently skipped, deletion proceeds.

### 5. `stop-session` does NOT trigger teardown; subsequent `terminate-issue` does

```
DEF-5: setup ran, worktree created
stop-session session-5
→ worktree preserved, no teardown sentinel
terminate-issue --action completed
→ teardown-DEF-5-*.txt written, worktree removed
```

✅ Pass — confirms the design intent (stop ≠ terminal).

### 6. Failing teardown → logged, worktree still removed

Replaced `cyrus-teardown.sh` with one that writes an "attempt" sentinel then `exit 1`:

```
DEF-6: setup ran, teardown attempted (attempt sentinel written), exited 1
→ worktree still removed
```

Server log:
```
[GitService] ❌ Repository teardown script failed: Command failed: bash ".../cyrus-teardown.sh"
[GitService]    Continuing despite teardown script failure...
[GitService] Removing git worktree: .../worktrees/DEF-6
[GitService] Deleted worktree directory for DEF-6
[EdgeWorker] Completed cleanup for DEF-6: stopped 1 session(s)
```

✅ Pass — non-blocking failure semantics confirmed.

### 7. Invalid `--action archived` → CLI rejects before RPC

```
$ f1 terminate-issue --issue-id issue-1 --action archived
✗ Invalid --action: archived. Must be one of: completed, canceled, deleted
```

✅ Pass.

### 8. Nonexistent issue → RPC error returned to CLI

```
$ f1 terminate-issue --issue-id issue-nope --action completed
✗ Failed to terminate issue: RPC Error (-32000): Issue issue-nope not found
```

✅ Pass.

## Multi-repo per-issue note

The teardown wiring iterates `options.repositories` and runs each repo's teardown with `cwd` set to the appropriate worktree subdirectory. That branch is fully covered by unit tests in `packages/edge-worker/test/GitService.test.ts` (multi-repo happy path, multi-repo with one teardown missing, multi-repo failure isolation). It is **not** exercised end-to-end through F1 because F1's two-repo mode places repos under different `workspaceBaseDir`s (the secondary repo uses a `secondary/` subdir), so a single issue does not produce the canonical multi-repo layout `~/.cyrus/worktrees/<issue>/<repo>/`. That is a property of F1's existing multi-repo orchestration, not of the teardown feature itself.

## Cleanup

```bash
kill <bun pid>            # stop F1 server
rm -rf /tmp/cyrus-hooks /tmp/f1-td-* /tmp/cyrus-f1-* /tmp/f1-drive.log
```

## Conclusion

The per-repo `cyrus-teardown.sh` feature behaves as specified across all terminal actions, the absent-script and failure paths, and the stop-vs-terminate distinction. End-to-end through F1 confirms the wiring from `terminate-issue` CLI through `CLIRPCServer` → `CLIIssueTrackerService.terminateIssue` → `CLIEventTransport.emitMessage` → `EdgeWorker.handleMessage` → `handleIssueStateChangeMessage` → `gitService.deleteWorktree({ repositories })` → `runRepoTeardownScript` → script execution → worktree removal.
