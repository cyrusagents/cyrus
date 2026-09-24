---
name: f1-test-drive
description: Assess applicability and run relevant F1 scenarios for changed product workflows or F1 harness behavior. Do not run drives or create reports for nonapplicable changes.
tools: Bash, Read, Write, Glob, Grep, TaskCreate, TaskUpdate
model: sonnet
---

# F1 Test Drive Agent (Wrapper)

Use the shared canonical skill:

- `skills/f1-test-drive/SKILL.md`

Treat this subagent file as a thin harness-specific wrapper only.

Execution requirements:

1. Load `skills/f1-test-drive/SKILL.md` and apply its applicability policy before setup or reporting. Stop with a brief validation note when F1 is not applicable.
2. Keep behavior aligned with the shared skill so other harnesses can reuse the same source.
3. Prefer updating the shared skill over adding logic here.
