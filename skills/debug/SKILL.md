---
name: debug
description: Full debugging workflow — reproduce the bug with a failing test, perform root cause analysis, then implement a minimal fix.
---

# Debug

Debug a reported issue using a structured reproduction-then-fix approach.

## Phase 1: Reproduction & Root Cause Analysis

1. **Investigate** — Analyze the bug report for key symptoms and error messages
2. **Trace** — Search the codebase for error occurrence patterns, trace from symptom to source
3. **Root cause** — Identify the root cause through data flow analysis and edge case checking
4. **Reproduce** — Create a minimal failing test case that reproduces the exact error
5. **Document** — Clearly document the root cause and reproduction steps

## Phase 2: Fix Implementation

1. **Plan** — Analyze the optimal fix approach based on root cause, check for similar fixes in the codebase
2. **Implement** — Make the minimal, targeted fix that addresses the root cause
3. **Verify** — Run the failing test to confirm it passes, then run the full test suite to check for regressions

## Principles

- **Minimal changes** — Fix the bug, nothing more
- **Targeted** — Only touch affected code paths
- **Tested** — The fix must make the failing test pass and not break existing tests
- **No unrelated improvements** — Stay focused on the specific bug
