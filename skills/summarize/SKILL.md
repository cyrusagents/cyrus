---
name: summarize
description: Format a final summary message for Linear. Your output is automatically streamed to the Linear agent session — just format it well, do not post it yourself.
---

# Summarize

Format a final summary of the work completed. Your output will be automatically rendered inside Linear — just write it as your response. Do **not** use any tool to post or save it.

## Content

Cover the following:
1. **Work Completed** — What was accomplished (1-2 sentences) and key outcome
2. **Key Details** — Files modified, important changes, PR link if created
3. **Status** — Completion status and any follow-up needed

## Format

- Aim for 3-5 paragraphs maximum
- Use clear, professional language suitable for Linear
- Use markdown formatting for readability
- **Collapsible sections**: Wrap "Changes Made" and "Files Modified" in `+++Section Name\n...\n+++`
- **@mentions**: Use the Linear profile URL format from `<assignee>` context (e.g. `https://linear.app/<workspace>/profiles/<username>`)

## Example

```
## Summary

[Brief description of what was done]

+++Changes Made
- [Key change 1]
- [Key change 2]
+++

+++Files Modified
- [File 1]
- [File 2]
+++

## Status

[Current status and any next steps]

[PR link if applicable]
```
