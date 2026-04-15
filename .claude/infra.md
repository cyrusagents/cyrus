# Infra & Dispatch

Operational guidelines for Cyrus dispatch and performance.

## Context Budget

Keep total loaded context under 70% of window capacity. If output quality degrades on complex issues, audit which context modules are loading and trim non-contributing ones.
