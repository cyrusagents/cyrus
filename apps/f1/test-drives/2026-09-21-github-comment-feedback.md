# Test Drive: GitHub comment feedback

**Date**: 2026-09-21
**Goal**: Validate session execution and activity rendering while correcting GitHub reply association and terminal reactions.
**Test repo**: `/private/tmp/f1-github-feedback-20260921`
**Runner**: Cursor, `composer-2`

## Verification results

### Issue tracker
- [x] Local issue `issue-1` / `DEF-1` created with the read-only task.
- [x] Issue ID, title and URL returned.
- [x] Session `session-1` started and remained queryable.

### EdgeWorker
- [x] Isolated worktree created from the test repository's local `main`.
- [x] Runner read README.md and returned `simple-rate-limiter`.
- [x] Nine activities recorded, including a shell action and the final response.
- [x] Session stopped and the F1 server shut down cleanly.

### Renderer
- [x] Thought, action and response activities have readable content and timestamps.
- [x] `--limit 3 --offset 3` returned exactly three of nine activities.
- [ ] Activity search was not exercised.

## Session log

Started the server on port 3600 with a fresh temporary Atmiko home and only the configured Cursor credential. No production webhook integrations were loaded.

```sh
ATMIKO_PORT=3600 apps/f1/f1 ping
ATMIKO_PORT=3600 apps/f1/f1 create-issue --title 'GitHub feedback smoke with configured Cursor credential' --description 'Read-only F1 validation. [repo=f1-test-repo] [agent=cursor] Read README.md and answer with one short sentence stating the package name. Do not modify files, commit, push, create pull requests, or send messages.'
ATMIKO_PORT=3600 apps/f1/f1 start-session --issue-id issue-1
ATMIKO_PORT=3600 apps/f1/f1 view-session --session-id session-1 --limit 3 --offset 3
ATMIKO_PORT=3600 apps/f1/f1 view-session --session-id session-1 --limit 20 --offset 0
ATMIKO_PORT=3600 apps/f1/f1 stop-session --session-id session-1
```

The authenticated run started at 10:47:45 UTC and posted its final response at 10:48:05 UTC. The initial attempt without loading the existing Cursor credential failed with `Invalid User API Key`; it was stopped before the authenticated retry. No secret was logged.

The test repository intentionally has no Git remote; worktree setup used local `main`. A Read permission rejection led the runner to read README.md through the permitted shell tool. The CLI still displayed the session as active after the response, so completion was verified from the response activity and runner result, then the session was explicitly stopped.

## GitHub-specific regression coverage

The F1 CLI surface does not exercise GitHub comment delivery. Focused webhook-handler and HTTP-contract tests cover the actual fix separately:

- PR timeline replies link to the exact triggering comment.
- Inline replies target the thread root, while reactions target the triggering child comment.
- Queued inline requests retain their eyes reaction and receive an acknowledgement in the same thread.
- Success adds `+1`; execution errors and delivery errors add `confused`.
- The eyes reaction is removed by the ID returned from GitHub; other reactions are untouched.
- A delayed acknowledgement cannot recreate eyes after completion.
- A result delivered before runner message storage still determines the terminal status.
- The bot's own comments are ignored with either a bare slug or a `[bot]` login.

This report does not claim a live GitHub comment/reaction test. The successful F1 run used the working checkout; the independently isolated PR checkout was built and validated separately.
