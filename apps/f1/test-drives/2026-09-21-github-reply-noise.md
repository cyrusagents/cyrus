# Test Drive: Concise GitHub replies and completed review requests

**Date**: 2026-09-21
**Goal**: Validate the session pipeline while removing redundant GitHub acknowledgements, duplicate completion summaries, and obsolete queued Codex work.
**Test repo**: `/private/tmp/f1-github-reply-noise-20260921`
**Runner**: Cursor, `composer-2`

## Verification results

### Issue tracker
- [x] Created local issue `issue-1` / `DEF-1` and received its title and URL.
- [x] Started session `session-1`; session metadata remained queryable.

### EdgeWorker
- [x] Created an isolated worktree from the test repository's local `main`.
- [x] Executed a read-only README task and returned the package name.
- [x] Recorded six activities, including a shell action and one final response.
- [x] Stopped the session and shut down the server gracefully.
- [x] No unhandled errors during the run.

### Renderer
- [x] Thought, action and response activities have readable content and timestamps.
- [x] `--limit 2 --offset 4` returned exactly the last two of six activities.
- [ ] Activity search was not exercised.

## Session log

Built the changed GitHub transport and EdgeWorker packages, then started the F1 server on port 3600 with a fresh temporary Atmiko home and the configured Cursor credential. Production webhook integrations were not loaded.

```sh
apps/f1/f1 init-test-repo --path /private/tmp/f1-github-reply-noise-20260921
ATMIKO_PORT=3600 apps/f1/f1 ping
ATMIKO_PORT=3600 apps/f1/f1 status
ATMIKO_PORT=3600 apps/f1/f1 create-issue --title 'Verify concise final responses after GitHub reply-noise fix' --description 'Read-only F1 validation. [repo=f1-test-repo] [agent=cursor] Read README.md and answer with one short sentence stating the package name. Do not modify files, commit, push, create pull requests, or send messages.'
ATMIKO_PORT=3600 apps/f1/f1 start-session --issue-id issue-1
ATMIKO_PORT=3600 apps/f1/f1 view-session --session-id session-1 --limit 30 --offset 0
ATMIKO_PORT=3600 apps/f1/f1 view-session --session-id session-1 --limit 2 --offset 4
ATMIKO_PORT=3600 apps/f1/f1 stop-session --session-id session-1
```

The session started at 11:25:49 UTC, returned `simple-rate-limiter` at 11:26:06 UTC, and was explicitly stopped at 11:27:03 UTC. The server stopped gracefully at 11:27:19 UTC. The CLI continued displaying `active` after the response; completion was verified from the response activity and successful runner result before stopping it.

## GitHub regression verification

The motivating example was [Viora-Mono #842](https://github.com/VioraOS/Viora-Mono/pull/842). A running agent posted its own completion comment, Atmiko posted the agent's final shipping-check answer, and a queued notification then repeated the already-resolved Codex review. These were separate publications, not repeated deliveries of one webhook.

Regression tests first reproduced seven failures: queue and change-request acknowledgements, execution of an already-resolved queued request, and false shipping blocks with missing, stale, or base-branch tracking. The corrected code passes:

- Queueing preserves the eyes reaction without posting a status comment.
- Both complete GitHub system prompts give Atmiko ownership of the final reply and restrict work to the triggering request.
- The exact automated review is checked when its queue slot becomes available; all resolved threads finish the request without a runner or another summary.
- Pagination includes later unresolved findings. Empty, unrelated or partial results do not establish completion; API failures continue normal processing.
- Human requests and cross-PR, cross-repository, foreign-origin or malformed review references are not silently skipped.
- A branch pushed by URL is recognized despite stale local tracking; genuinely unshipped work still triggers the guardrail.

The built `GitHubCommentService.isReviewFullyResolved` was also run read-only against review `5265084414` on the real PR. It returned `true` for that review's six resolved threads. This check did not post any comments or reactions.

Validation: all package tests passed (**2021 passed, 2 existing skips**); repository-wide typechecking passed; lint completed with 10 existing warnings in unchanged files; changed-package builds passed.

## Final retrospective

F1 verified issue creation, worktree/session execution, activity rendering, pagination and cleanup using the changed checkout. GitHub delivery behavior is covered by webhook-handler and HTTP-contract tests, plus the live read-only resolution check. This run does not claim a live GitHub comment/reaction delivery test or a production rollout.
