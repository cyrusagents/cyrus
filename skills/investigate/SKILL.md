---
name: investigate
description: Researches the codebase to answer a question — searches for relevant files, gathers context, and writes a clear, direct answer grounded in the code. Use when an issue asks how something works, why it behaves a certain way, where something lives, or whether something is possible — any question or research request with no code change expected. Not for making code changes (use implementation), fixing a reported bug (use debug), or summarizing finished work (use summarize).
---

# Investigate

Answer the question by reading the actual code, not from memory. Every claim must be grounded in what the repository really does, with `file:line` references a reader can open and check.

This is research-only. Do not edit, create, or delete files, and do not commit, push, or open a PR/MR. If the question turns out to require a code change, say so and recommend the right path — a bug goes to debug; a feature, refactor, or PR/MR review change goes to implementation — rather than making the change here.

## Delivery contract

Your final assistant message IS the Linear response — it is streamed back to the agent session automatically. Write the answer as your response. Do NOT post or save it with any tool (that double-posts). It must be the LAST thing you output, so it is not buried under other text.

## Approach

1. Pin down what is actually being asked. If the report is thin or ambiguous, fetch the issue with the issue tracker's `get_issue` tool — and read its comments too, not just the description — before researching.
2. Search the codebase for the relevant files, functions, types, and call sites. Follow the real code path rather than guessing — read the code on the path before forming a conclusion.
3. Read enough to be sure. Trace callers and callees until the evidence supports one answer; do not stop at the first plausible match. If the code contradicts an assumption in the question, say so.
4. Answer directly, citing the code that proves each claim. Distinguish what the code does (fact, with a reference) from inference about it.

If the evidence is genuinely inconclusive, say what was found, what remains unknown, and what would resolve it — do not fabricate certainty.

## Answer format

Write Linear-compatible markdown. Lead with the direct answer in the first sentence — no preamble, no restating the question. Then support it. The exact shape is a judgment call; adapt to what the question warrants — a one-line factual question deserves a one-line answer.

- Cite code as `path/to/file.ts:42` (forward slashes, real line numbers read from the file in this session — never invented or remembered) so the reference is clickable in the timeline.
- Push long evidence — call chains, multi-file walkthroughs, quoted snippets — into `+++Section Name` / content / `+++` collapsible sections so the visible answer stays scannable.
- For @mentions, use the Linear profile URL from the `<assignee>` context: `https://linear.app/<workspace>/profiles/<username>`.

A grounded answer reads like: "Cross-repo routing priority is defined in `packages/edge-worker/src/PromptBuilder.ts` (the `<repository_routing_context>` block): description tag wins, then routing labels, then project, then team — first match wins," with the supporting walkthrough folded into a `+++` section. Read the file for the current line numbers; do not carry them from memory.
