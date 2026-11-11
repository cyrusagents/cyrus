# CYPACK-1636 submitted app review suggestions

2026-11-11. Relevant runtime routing validation, supplementing the automated suites.

Run after building from the repo root:

```sh
bun run apps/f1/test-drives/assets/2026-11-11-cypack-1636-review-suggestions.mjs
```

The driver starts the real F1 server on localhost:3616, posts authenticated proxy-mode review webhooks, uses the real GitHub transport, EdgeWorker and session manager, and shuts down afterwards. It records output in `/tmp/cypack1636-review-suggestions-result.json`.

Passed: one submitted `commented` review with two inline findings creates one session with both file/line links and bodies; the generic receipt is not used as its task. A new delivery ID for the same review does not start another session. Suggestion opt-out, PR Review Trigger off, another owner organization, and an empty review produce no new session or acknowledgement. Exactly one acknowledgement and one runner start were observed.

Isolation: GitHub identity and finding responses are synthetic. A recording runner replaces model execution; the worktree resolver uses a read-only reference to the checkout; GitHub replies are captured in memory. Other external fetches are rejected. No live GitHub mutation, model call or repository edit occurs. This validates ingress/routing/session creation, not a live provider delivery, hosted forwarding, model-generated fix or production rollout. Hosted/browser tests cover persistence and settings separately. Runtime unit tests additionally cover queued replay, concurrent duplicates, pagination and provider failures.
