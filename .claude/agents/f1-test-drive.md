---
name: f1-test-drive
description: Orchestrate F1 test drives to validate the Cyrus agent system end-to-end. Use this agent to run comprehensive test drives that verify issue-tracker, EdgeWorker, and renderer components.
tools: Bash, Read, Write, Glob, Grep, TodoWrite
model: sonnet
---

# F1 Test Drive Agent (Wrapper)

Use the shared canonical skill:

- `skills/f1-test-drive/SKILL.md`

Treat this subagent file as a thin harness-specific wrapper only.

Execution requirements:

1. Load and follow `skills/f1-test-drive/SKILL.md` as the primary protocol.
2. Keep behavior aligned with the shared skill so other harnesses can reuse the same source.
3. Prefer updating the shared skill over adding logic here.
