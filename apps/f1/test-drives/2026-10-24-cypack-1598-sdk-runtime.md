# CYPACK-1598: Claude Agent SDK 0.3.310 runtime acceptance

**Date:** 2026-10-24  
**Goal:** Verify that the 0.3.310 upgrade preserves Cyrus's tool registry, permission boundary, routing, and session lifecycle.  
**Tested source:** local `cypack-1598` branch and published `cyrus-core@0.2.75-test.4`.

## Results

- [x] A clean registry install of `cyrus-core@0.2.75-test.4` resolved Claude Agent SDK 0.3.310, imported successfully, exposed the refreshed tool lists, and passed `npm audit` with zero vulnerabilities.
- [x] F1 created `DEF-1`, accepted repository selection, created its isolated worktree, and initialized the runner with the expected 30 built-in tools.
- [x] The emitted query options retained `permissionMode: default`; the effective allowlist contained the expected 34 tools after configured additions.
- [x] Routing, model, prompt, and error activities rendered coherently in the paginated session view.
- [x] The stop signal was accepted and the F1 server shut down gracefully.
- [ ] The bounded model turn could not exercise `Read` and `Bash`: the existing Claude OAuth credential expired before the request and returned HTTP 401. No credentials were read, changed, or substituted.

The prior 0.3.309 acceptance in `2026-10-23-cypack-1596-sdk-runtime.md` completed the same authenticated `Read` and foreground `Bash` path. Upstream 0.3.310 is a parity release for Claude Code 2.1.310, so this run focuses on the changed package identity and confirms that Cyrus initialization and policy inputs remain intact. A credential owner must reconnect before repeating the external model call.

Primary change record: [Agent SDK changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md#03310).

## Session log

1. Started F1 on port 3600 with `/private/tmp/cypack-1598-f1-repo-20261024`.
2. Created `DEF-1`, started `session-1`, and selected the configured fixture repository.
3. Confirmed repository routing, worktree creation, the 30-tool built-in registry, `permissionMode: default`, and the 34-tool effective allowlist.
4. The model request returned `401 OAuth access token has expired` before any tool invocation.
5. Viewed all six activities with `--limit 10 --offset 0`, stopped the session, and shut down the server cleanly.
