---
name: implementation
description: Implements requested code changes — writes production-ready code that follows existing patterns and verifies it against the issue's acceptance criteria. Use when an issue requests a feature, refactor, new capability, or PR/MR review change. Not for bug reports (use debug) or questions about how the code works (use investigate).
---

# Implementation

Implement the requested code change so it satisfies the issue's acceptance criteria and matches the surrounding codebase. Work in two phases; complete Phase 1 before writing code.

Paste this checklist into your response and check items off as you go — Cyrus renders it in the Linear timeline:

```
- [ ] Issue read; acceptance criteria extracted
- [ ] Existing patterns and test conventions studied
- [ ] Change implemented, scoped to the request
- [ ] Tests added/updated (or no-suite case noted)
- [ ] Change confirmed working at the unit level (output read)
- [ ] Each acceptance criterion checked
```

## Phase 1: Understand and plan

Goal: know exactly what "done" means before changing anything.

1. Read the issue with the issue tracker's `get_issue` tool — description, comments, linked context. For a PR/MR review change, the relevant review comments are already in the session context; read those rather than fetching them.
2. Extract the acceptance criteria. Pull out every explicit criterion; if none are stated, derive the implied ones from the title, description, and any examples. These are what verify-and-ship validates against.
3. Study existing patterns. Locate the files to change and read neighboring code: naming, error handling, module structure, test conventions, and the libraries already in use. Match these rather than introducing new ones.
4. Plan the minimal set of edits that satisfies the criteria. Note which files to touch and how the change will be tested.

## Phase 2: Implement and verify

Goal: working, focused code backed by fresh evidence.

1. Write the change as production-ready code that follows the patterns from Phase 1, handling the edge cases and error paths the criteria imply.
2. Stay in scope. Change only what the issue requests; skip unrelated refactors, reformatting, and drive-by improvements that widen the diff — note them for later instead.
3. Add or update tests for the new behavior using the project's existing test conventions, covering the edge cases from the criteria.
4. Run the tests that cover your change as a self-check and read the output. Report from fresh command output, never from expectation — no "should work", "probably", or "looks done". verify-and-ship runs the authoritative full suite, lint, and typecheck gate, so this step only needs to confirm the change works at the unit level.
5. Check each acceptance criterion from Phase 1 and note any that cannot be met and why.

If the repository has no test suite, state that plainly and verify the change another concrete way: run the affected command, exercise the code path, or describe the manual check performed. Do not invent passing tests that do not exist.

## Principles

- Criteria-driven — the acceptance criteria define done; check against them, not a vague sense of completion.
- Pattern-matching — new code reads as if the existing authors wrote it.
- Focused — the diff contains only what the issue asked for.

Code changed, so the workflow continues to verify-and-ship — which runs the full checks, then commits, pushes, and opens the PR/MR — then summarize. Carry any unmet criteria or failing tests forward rather than stalling here. Do not commit, push, or open a PR/MR here.
