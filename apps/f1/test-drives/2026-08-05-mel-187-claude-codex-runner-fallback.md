# Test Drive: MEL-187 Claude-to-Codex Quota Fallback

**Date**: 2026-08-05
**Goal**: Verify that a replayed rejected Claude quota event transitions the same Cyrus work item to Codex and posts one final response.
**Test Repo**: `/tmp/f1-mel-187.yaBy5N/repo`

## Verification Results

### Issue-Tracker

- [x] Issue created
- [x] Issue ID returned
- [x] Issue metadata accessible

### EdgeWorker

- [x] Session started
- [x] Worktree created
- [x] Replayed `five_hour` rejected quota event triggered Codex
- [x] Follow-up prompt resumed the Codex session
- [x] Session stopped cleanly

### Renderer

- [x] Transition thought appeared before Codex activity
- [x] Reset time was present in the transition thought
- [x] Exactly one final response was posted for the fallback turn
- [x] The superseded Claude success result was absent
- [x] Pagination and activity search worked

## Session Log

The F1 server used `CYRUS_REPLAY_CLAUDE_QUOTA=1`, which configures an implicit Claude default, a `five_hour` Claude-to-Codex fallback policy, and deterministic replay runners.

```text
CYRUS_REPLAY_CLAUDE_QUOTA=1 CYRUS_PORT=3600 \
  CYRUS_REPO_PATH=/tmp/f1-mel-187.yaBy5N/repo \
  bun run apps/f1/server.ts

CYRUS_PORT=3600 ./f1 create-issue \
  --title "MEL-187 replayed Claude quota fallback" \
  --description "Verify rejected five_hour quota transitions from implicit Claude default to Codex with one final response." \
  --labels primary

Issue ID: issue-2
Identifier: DEF-2

CYRUS_PORT=3600 ./f1 start-session --issue-id issue-2
Session ID: session-2
```

The first-page activity order was:

```text
thought   I've received your request and I'm starting to work on it.
thought   Routing (Label routing) — F1 Test Repository → main
thought   Claude quota exhausted (five_hour); continuing with Codex. Quota resets at ...
thought   Using model: gpt-5.5
response  Codex completed the replayed fallback work item.
```

Search verification:

```text
search "Codex"                         -> 2 activities
search "Claude result must be suppressed" -> 0 activities
```

Continuation verification:

```text
CYRUS_PORT=3600 ./f1 prompt-session \
  --session-id session-2 \
  --message "Continue with Codex"

resumeSessionId=f1-replay-codex-session
response  Codex completed the replayed fallback work item.
```

The server stopped gracefully after `./f1 stop-session --session-id session-2`.

## Final Retrospective

The replay validated the complete CLI issue-tracker, EdgeWorker, worktree, runner transition, activity rendering, and continuation path. The initial unlabeled issue intentionally demonstrated that F1 routing requires a matching repository label; the successful drive used the existing `primary` routing label. The test repository has no `origin`, so Git fetch logged its expected local-branch fallback before creating the worktree.
