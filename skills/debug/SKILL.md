---
name: debug
description: Full debugging workflow — reproduce the bug with a focused check, perform root cause analysis, then implement a minimal fix.
---

# Debug

Debug a reported issue using a structured reproduction-then-fix approach.

## Phase 1: Reproduction & Root Cause Analysis

1. **Investigate** — Analyze the bug report for key symptoms and error messages
2. **Trace** — Search the codebase for error occurrence patterns, trace from symptom to source
3. **Root cause** — Identify the root cause through data flow analysis and edge case checking
4. **Reproduce** — Reproduce the exact error with the smallest useful check (a command, dry run, manual flow, or automated test)
5. **Document** — Clearly document the root cause and reproduction steps

## Phase 2: Fix Implementation

1. **Plan** — Analyze the optimal fix approach based on root cause, check for similar fixes in the codebase
2. **Implement** — Make the minimal, targeted fix that addresses the root cause
3. **Verify** — Repeat the reproduction to confirm the fix and run relevant existing checks. Follow `verify-and-ship` for proportionate scope; add a regression test only when the concrete failure warrants durable coverage

## Principles

- **Minimal changes** — Fix the bug, nothing more
- **Targeted** — Only touch affected code paths
- **Verified** — Confirm the reproduction succeeds after the fix and preserve relevant existing safeguards; a new test file is not mandatory
- **No unrelated improvements** — Stay focused on the specific bug
