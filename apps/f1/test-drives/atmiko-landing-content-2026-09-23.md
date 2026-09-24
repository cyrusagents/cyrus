# Test drive: Atmiko landing page content refactor

Date: 2026-09-23

The landing page was rewritten around existing product capabilities. This smoke test checks the background investigation workflow described by the page; it does not certify the example PR outcomes.

- Initialized isolated repository `/tmp/f1-atmiko-landing-validation`.
- Started the F1 server on port 3600; ping and ready status passed.
- Created `issue-1` / `DEF-1` with an explicit `[repo=f1-test-repo]` selector.
- Started `session-1` to read README.md and src/rate-limiter.ts and summarize implemented and missing functionality without edits or external messages.
- Observed repository routing, model selection, task updates, two Read actions, and a final response.
- Pagination returned 16 timestamped activities across offsets 0 and 10. The final response arrived at 01:45:09 UTC.
- Stopped the session and shut down the test server.

Browser, static build, type-check, and content/link validation are recorded in `apps/web/VALIDATION.md`.
