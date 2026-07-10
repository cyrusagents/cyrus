---
name: new-agent-harness
description: Checklist-driven work when implementing a new agent CLI harness (runner adapter for Cursor, OpenCode, Gemini, etc.). Use when adding a new runner package, mapping a new provider's stream events, or integrating a new coding-agent CLI into EdgeWorker.
---

# New agent CLI harness

Implement or extend a runner so EdgeWorker can drive a new agent CLI with the
same session lifecycle, activity visibility, and ship gates as existing runners
(`claude-runner`, `cursor-runner`).

## Checklist

Paste into your response and check off as you go:

```
- [ ] Session lifecycle + turn limits verified
- [ ] Prompt / instruction model documented and wired
- [ ] Streaming event schema captured + replay tests
- [ ] Final message → response activity always posted
- [ ] Tools/permissions (+ static config translation if needed)
- [ ] supportsStreamingInput set correctly
- [ ] MCP / custom tools mapped
- [ ] Label + description selector selection tests
- [ ] Tool lifecycle visible as activities (not dropped)
- [ ] Usage / stop-reason / types mapped
- [ ] Config defaults + migrations
- [ ] Unit + F1 validation green
```

## Procedure

1. Read the full checklist and lessons in
   `agent-docs/new-agent-harness.md` — that file is the source of truth.
2. Study existing adapters: `packages/claude-runner/`, `packages/cursor-runner/`,
   and how `AgentSessionManager` / `RunnerSelectionService` wire them.
3. Implement against the checklist items; prefer shared contracts in
   `packages/core` over provider-specific types leaking upward.
4. **Tool lifecycle is load-bearing.** If the provider's tool start/complete
   events are not mapped, Linear timeline action/file-edit visibility is lost.
5. Validate with package tests and an F1 drive (`f1-test-drive`) covering
   label selection, description selectors, tool visibility, and final response.
6. Ship via `verify-and-ship` (changelog, checks, PR).

## Key references

| Topic | Where |
| --- | --- |
| Full 12-section checklist + Cursor lessons | `agent-docs/new-agent-harness.md` |
| Architecture / key paths | `agent-docs/architecture-and-runtime.md` |
| Permissions / sandbox dual layer | `agent-docs/dev-gotchas.md` |
| F1 protocol | `skills/f1-test-drive/SKILL.md`, `apps/f1/CLAUDE.md` |
