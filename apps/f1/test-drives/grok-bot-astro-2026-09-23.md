# Test Drive: Grok Bot Astro addition

**Date**: 2026-09-23
**Goal**: Verify the existing Atmiko session pipeline still runs alongside the new independent Astro app.
**Test Repo**: `/tmp/f1-grok-bot-validation`

## Verification results

- [x] F1 repository initialized; server started on port 3600.
- [x] Health and ready status returned.
- [x] Issue `issue-1` / `DEF-1` created.
- [x] Session `session-1` started.
- [x] Repository selection resolved with `[repo=f1-test-repo]`.
- [x] Thought, routing, Read action, and final response activities appeared with timestamps.
- [x] Activity pagination (`--limit 10 --offset 0`) returned readable results.
- [x] Session stopped and server cleaned up.

## Session log

The isolated task asked the runner to read README.md and summarize it without editing files or contacting external services. Seven activities were recorded, including the Read action at 17:45:15 UTC and final response at 17:45:20 UTC. No changes were requested to the test repository.

## Retrospective

The first session requested a repository selection; an explicit repo selector resolved routing. This smoke test validates the Atmiko pipeline only. The Astro site's build, type check, browser comparison, and interactive checks are documented separately in `apps/web/VALIDATION.md`.
