# F1 Test Drive — Default Skill Suite Routing & Adherence Validation

**Date:** 2026-06-28
**Branch:** `improve-skill-descriptions` (PR #1 — rewritten default workflow skills)
**Goal:** Validate that the rewritten `debug` / `implementation` / `investigate` / `summarize` / `verify-and-ship` skills (a) route correctly from issue content and (b) actually follow the new disciplines (reproduce-first, acceptance-criteria extraction, read-only research, delivery contract).

## Setup

- `pnpm install && pnpm build` from repo root. The build's `cp -rL cyrus-skills-plugin dist/` step dereferences the symlinks, so the **rewritten** skills are staged into `dist/` and deployed by `DefaultSkillsDeployer` into the F1 server's fresh `cyrusHome`. Confirmed the deployed `debug/SKILL.md` contained the new "fails for the right reason" gate.
- `./f1 init-test-repo --path /tmp/f1-skill-eval-repo` (rate-limiter scaffold). The repo has **no test framework** (`npm test` exits 1) — useful for exercising the no-suite fallback.
- Planted a deterministic bug for the debug scenario: an off-by-one in `consumeTokenBucket` (`state.tokens - tokensToConsume + 1`) so consumed tokens are never fully deducted.
- `CYRUS_PORT=3601 CYRUS_REPO_PATH=/tmp/f1-skill-eval-repo bun run server.ts` (CLI platform mode, model `sonnet`).
- Each session required a one-shot repo-selection prompt (no routing config), after which the runner started.

## Results

| # | Issue (natural language) | Expected skill | Routed to | Verdict |
|---|---|---|---|---|
| 1 | "Token bucket lets one extra request through" (bug report) | `debug` | `debug` | ✅ PASS |
| 2 | "How does refill work, can clients burst?" (question) | `investigate` | `investigate` | ✅ PASS |
| 3 | "Implement the sliding window algorithm" (feature) | `implementation` → `verify-and-ship` | `implementation` → `verify-and-ship` | ✅ PASS (ship phase limited, see below) |

Routing was observed via the `Skill` action activity (`{"skill":"…"}`) at the start of each session. **All three routed correctly on first try.**

### Scenario 1 — bug → `debug` (deep adherence PASS)

The new reproduce-first discipline was followed exactly:
1. Routed to `debug`; pasted the progress checklist (rendered with ⏳/🔄/✅ in the timeline).
2. Read the code, identified the off-by-one — but did **not** fix immediately.
3. Wrote a reproduction test, ran it (`Bash (Error)` = failed as intended), and the agent's own words: *"Test fails for the exact right reason: `request 4 should be denied (capacity exhausted)`"* — the rewrite's **right-reason gate**, honored verbatim.
4. No test framework existed → it used the deterministic `npx tsx --test` fallback (the skill's no-suite path), and later wired up the `package.json` test script.
5. Applied the minimal fix (removed the `+ 1`), re-ran the test (pass), typechecked clean.

Final worktree: `rate-limiter.ts` fixed, `rate-limiter.test.ts` added asserting "request 4 should be denied", `package.json` test script set — a minimal 3-file diff.

### Scenario 2 — question → `investigate` (deep adherence PASS)

1. Routed to `investigate`; only `find` + `Read` actions — **worktree stayed clean (zero edits)**, confirming the read-only guardrail.
2. Streamed the answer as the final `[response]` activity (the shared **delivery contract** — not posted via a tool).
3. Answer was grounded with `file:line` citations (`src/rate-limiter.ts:111`, `:123–128`, `:159`) and used a `+++` collapsible section — the skill's citation + format discipline.
4. It also noticed the planted `consume` bug and correctly said *"this is a code change, so fixing it is out of scope here"* — the rewrite's recommend-the-right-path rule.

### Scenario 3 — feature → `implementation` → `verify-and-ship`

1. Routed to `implementation`; checklist showed the rewrite's exact items (*"Issue read; acceptance criteria extracted"*, *"Existing patterns and test conventions studied"*).
2. Phase 1 (study patterns) → Phase 2 (implement) → typecheck, then **handed off to `Skill: verify-and-ship`** — the cross-skill chain works.
3. Implementation was correct and criteria-driven: `checkSlidingWindow`/`consumeSlidingWindow` using `SlidingWindowConfig`, request eviction via `filter(ts => ts > windowStart)`, `check()`/`consume()` routed to it; all four acceptance criteria satisfied.
4. `verify-and-ship` pasted its checklist, validated each acceptance criterion, and committed — then `git push` failed with `fatal: Could not read from remote repository`.

## Known limitation — verify-and-ship ship phase not exercisable in F1 CLI mode

F1's CLI platform mode has **no real GitHub/GitLab remote**, so `verify-and-ship`'s push + `gh pr create` cannot complete, and the session ended at the push failure (followed by an unrelated bundled-agent-SDK `r.trim` error). Consequently the **red-PR ready-state safety fix** (failing checks ⇒ keep the PR a draft, surface failures, demote-to-draft on re-run) was **not** validated end-to-end here. That logic is covered by code review + the adversarial review pass in PR #1; validating it live requires a scenario with a real remote (a throwaway GitHub repo) — recommended as a follow-up.

## Conclusion

Routing is correct for all three issue shapes, and the headline new disciplines — reproduce-before-fix with the right-reason gate (`debug`), read-only research + delivery contract + file:line citations (`investigate`), acceptance-criteria extraction + clean handoff (`implementation` → `verify-and-ship`) — are demonstrably followed by a live `sonnet` agent. The only unvalidated item is the `verify-and-ship` ship-phase ready-state logic, blocked by F1 CLI mode having no remote.
