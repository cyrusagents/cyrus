---
name: debug
description: Debugs a reported issue — reproduces the bug with a failing test, finds the root cause, then ships a minimal fix. Use when an issue reports a bug, error, crash, exception, or regression. Not for new features or refactors (use implementation) or questions about how code works (use investigate).
---

# Debug

Fix a reported bug with a reproduce-then-fix discipline: prove the bug exists with a failing test, find the root cause, then make the smallest change that resolves it. Work in two phases; complete Phase 1 before proposing any fix.

Paste this checklist into your response and check items off as you go — Cyrus renders it in the Linear timeline:

```
- [ ] Reproduced the bug
- [ ] Wrote a test that fails for the right reason
- [ ] Identified the root cause
- [ ] Applied the minimal fix
- [ ] Failing test now passes
- [ ] Full suite passes (no regressions)
```

## Phase 1: Reproduce and find the root cause

Goal: a failing test that proves the bug, plus a clear explanation of why it happens.

1. Read the report for the exact symptom: the error message, stack trace, failing input, or steps to reproduce. If detail is thin, fetch the issue with the issue tracker's `get_issue` tool — and read its comments too, not just the description, since maintainers often add the real reproduction steps there after creation.
2. Trace from symptom to source. Search the codebase for the error string, the failing function, and the data path that produces the bad result. Follow the real code path rather than guessing — read the code on the path before forming a theory.
3. Write a minimal test that reproduces the bug. Target the smallest unit that exhibits it, asserting the correct behavior the bug currently violates. If an automated test is genuinely impractical — no test framework in the project, or the bug needs integration, timing (a race), or external/prod-only state to surface — reproduce it with the smallest deterministic alternative instead: a one-off script, a REPL snippet, or a documented manual command you run both before and after the fix. Treat that reproduction as the evidence in place of a unit test.
4. Run the reproduction and read its output. Confirm it fails — and fails for the *right reason*: the assertion or runtime error described in the report, not an unrelated import, setup, fixture, or compile error. If it fails for the wrong reason, fix the test scaffolding and re-run until the failure is the genuine bug. A test that passes, or fails on the wrong line, has not reproduced anything.
5. State the root cause: the specific line or logic that produces the wrong behavior, and why. Distinguish the root cause from the symptom — fixing where the error surfaces while leaving the real defect in place is the most common debugging mistake. If the evidence does not yet support a single root cause, keep tracing; do not proceed on a guess.

## Phase 2: Apply the minimal fix

Goal: the smallest change that makes the failing reproduction pass without breaking anything else.

1. Decide the fix that addresses the root cause from Phase 1. Scan for similar fixes already in the codebase and follow the existing pattern.
2. Make the minimal, targeted change. Touch only the code on the root-cause path. Do not bundle in refactors, style changes, or unrelated improvements — note them for later instead.
3. Run the reproduction and watch it pass, then run the full test suite and read the output to confirm no regressions. Fix any new failures before continuing. Report from fresh command output, never from expectation — no "should work", "probably", or "looks done"; only after seeing the reproduction pass and the suite stay green.

## Principles

- Root cause, not symptom — fix the underlying defect, not the place the error happens to surface.
- Minimal and targeted — fix the bug and nothing more; stay on the root-cause path.
- Evidence-required — every "fixed" claim is backed by a reproduction that failed before and passes now, plus a green suite.

Code changed, so the workflow continues to verify-and-ship — which runs the full checks, then commits, pushes, and opens the PR/MR — then summarize. Do not commit, push, or open a PR/MR here.
