---
name: summarize
description: Formats the final summary of completed work for Linear, narrating what was done, the key changes, and any follow-up. Use as the last step of any workflow once the work is finished. Not for answering questions or research (use investigate).
---

# Summarize

Write the final summary of the work that was completed. Keep it tight, factual, and grounded in what actually happened this session.

## Delivery contract

Your final assistant message IS the Linear response — it is streamed back to the agent session automatically. Write the summary as your response. Do NOT post or save it with any tool (that double-posts). It must be the LAST thing you output, so it is not buried under other text.

## What to cover

1. **Outcome** — What was accomplished and the result, in one or two sentences.
2. **Key changes** — The substantive changes, files touched, and the PR/MR link if one was created by verify-and-ship.
3. **Status** — Whether the work is complete, plus any follow-up, known limitations, or unresolved failures carried over from earlier work.

## Format

Write Linear-compatible markdown. Lead with the outcome — no preamble. Keep the visible body short and push supporting detail into collapsible sections:

- Wrap long lists (changes made, files modified) in a `+++Section Name` / content / `+++` collapsible block (see the example for the exact shape) so the timeline stays scannable.
- For @mentions, use the Linear profile URL from the `<assignee>` context: `https://linear.app/<workspace>/profiles/<username>`. If assignee fields are empty, omit the @mention.

Beyond leading with the outcome and using collapsible sections for detail, the exact shape is your judgment — adapt to what the work warrants.

## Example

The surrounding fence below only shows the shape — do not wrap your actual output in a code fence (that would render the `+++` sections literally instead of as Linear collapsibles).

```
## Summary

Added retry-with-backoff to the webhook client so transient 5xx responses no longer drop events. PR: [#412](https://github.com/org/repo/pull/412)

+++Changes made
- New `withBackoff` wrapper around the fetch call (3 retries, jittered delay)
- Surfaced retry count in the structured log line
+++

+++Files modified
- packages/ndjson-client/src/WebhookClient.ts
- packages/ndjson-client/test/WebhookClient.test.ts
+++

**Status:** Complete and ready for review. The full test suite passes; no follow-up needed.
```
