# Cost review takeaways: DEV-139

**Trace:** [Langfuse DEV-139](http://100.93.103.32:3003/project/cyrus/traces?peek=cyrus-700fcc9a-e013-42ba-b90f-ea399edaf0cb&timestamp=2026-07-10T08%3A07%3A10.856Z)  
**Trace ID:** `cyrus-700fcc9a-e013-42ba-b90f-ea399edaf0cb`  
**Date:** 2026-07-10  
**Total:** **$11.55** · **~50 min** · **116** assistant turns · model **`claude-opus-4-8`** · Cyrus **`0.2.66+a26ea53`**

Task was a real feature (opt-in `readParentDirectory` / “not accessible” screenshot), shipped as PR #25. Cost is high mainly because **context never compacted**, not because any single turn was insane.

---

## Where the money went

Fitted exactly from Langfuse usage (R² = 1.0 at Sonnet-class rates Langfuse applied: $5 / $6.25 / $0.50 / $25 per MTok for in / cache-write / cache-read / out):

| Bucket | Tokens | Cost | Share |
|--------|--------|------|-------|
| **Cache read** | 15.7M | **$7.86** | **68%** |
| Output | 90k | $2.24 | 19% |
| Cache write | 212k | $1.33 | 12% |
| Bare input | 24k | $0.12 | 1% |

So this is a **re-read-the-growing-context** bill, not a “huge prompt once” bill.

### By phase

| Phase | Turns | Cost | Context range | $/turn |
|-------|------:|-----:|---------------|-------:|
| Intake / plan | 8 | $0.91 (8%) | 38k → 70k | $0.11 |
| Implementation | 72 | **$5.95 (52%)** | 72k → 156k | $0.08 |
| verify-and-ship | 28 | **$3.67 (32%)** | 161k → 212k | $0.13 |
| summarize | 1 | $0.15 | 213k | $0.15 |
| Follow-up after idle (~19 min gap) | 7 | $0.86 (8%) | 215k → **218k** | $0.12 |

Per-turn cost rises with context: ~$0.07 at 75–100k → **~$0.15 at 175–200k**.

---

## Root cause: auto-compact never fired

Config has:

```json
"claudeAutoCompactWindow": 120000
```

Build includes PR #18 (early compact) + PR #21 (`compact_boundary` visibility). Empirically you expected something like “window 100k → compact around ~70k.”

What the trace/transcript show instead:

1. Context grew **monotonically 38k → 218k** (no drops ≥30%).
2. **Zero** `compact_boundary` observations in this trace.
3. **Zero** `compact_boundary` observations project-wide in Langfuse (`totalItems: 0`).
4. Session JSONL system subtypes are only `init`, `thinking_tokens`, `session_state_changed`, `task_*`, one `api_retry` — **no compact events**.

So the cost-control knob you set **did not take effect for this run**. The session behaved like native ~1M-window compact: never hit the wall, never summarized, kept re-reading the full history every turn.

**~81% of spend** ($9.34) was on turns already ≥100k context. That is exactly what early auto-compact is meant to cut.

Likely follow-ups to debug:

- Confirm runtime actually passes `settings: { autoCompactWindow: 120000 }` into the SDK for mention/resume paths (code path exists in `ClaudeRunner`).
- Confirm Claude Code **2.1.185** still honors it the same way as the earlier empirical test (Opus + this SDK version may differ).
- Until you see `compact_boundary` events in Langfuse, treat `claudeAutoCompactWindow` as **unverified / possibly inert**.

---

## Secondary amplifiers

### 1. Default model is Opus

No `claudeDefaultModel` in `~/.cyrus/config.json`. Runner default is `"opus"` → `claude-opus-4-8`.

Langfuse’s $11.55 is priced like Sonnet-class rates. If Anthropic bills real Opus ($15/$75-class), **true API spend could be ~3×** that figure. Worth checking LiteLLM/provider invoice, not only Langfuse.

### 2. Long single session, stacked skills

Same Claude session ran implementation → verify-and-ship → summarize → follow-up. Skill bodies and tool history **accumulate** instead of resetting between subroutines.

Tools: **69 Bash**, 24 Read, 21 Edit, plus tests/PR friction. Each tool result becomes next-turn cache.

### 3. verify-and-ship was expensive and noisy

~$3.67 at 160–212k context, including:

- Full suite / pre-existing failures investigation  
- `gh` auth / wrong account push friction  
- Long assistant writeups (several 2–3k output turns)

That phase alone is ~1/3 of the bill **on top of already-large context**.

### 4. Keep-alive preserved the fat context

Idle ~08:36 → 08:55, then 7 more turns still at **214–218k**. Keep-alive avoided a resume rewrite (good), but without compact it also **preserved a $0.12+/turn tax**.

---

## Rough “what good would look like”

If compact had held effective context near **~80–100k** after the first threshold:

- Cache-read volume would drop a lot on the last ~90 turns (the $9+ high-context block).
- Ballpark recovery: **~$3–5+** on this trace alone (more if real Opus rates).
- You’d still pay for Opus + 100+ tool turns + verbose verify — so maybe **~$6–8** residual, not “cheap,” but clearly better than **$11.55 with unbounded growth**.

---

## Actionable takeaways

| Priority | Action |
|----------|--------|
| **P0** | Treat missing `compact_boundary` as a **live regression**: config 120k + no compact to 218k. Reproduce with a long F1/session and confirm settings reach Claude Code 2.1.185. |
| **P1** | Set `claudeDefaultModel` to **sonnet** (or similar) unless the issue needs Opus. Biggest easy lever after compact. |
| **P2** | Keep verify-and-ship lean: don’t re-run huge suites when unit tests for the touched surface pass; surface pre-existing failures without long digressions. |
| **P3** | Consider compacting (or starting a fresh runner) between **implementation** and **verify-and-ship** if SDK auto-compact remains unreliable. |
| **P4** | Cross-check Langfuse $ vs provider bill for Opus — Langfuse may understate. |

---

## Bottom line

This task is still costly because **context auto-compaction did not run**, so **cache re-reads of a 40k→218k transcript ate ~2/3 of the bill**, on **Opus**, across **116 turns** with a heavy verify/PR tail. The feature work itself is only part of the story; the missing compact is the smoking gun.
