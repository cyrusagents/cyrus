# CYPACK-1660: Cyrus 0.2.86-test.0 candidate verification

**Date:** 2026-11-25
**Feature source:** `5a7bb7bce0c493799f96c15d5faaa97cfda9865b` ([cyrus#1624](https://github.com/cyrusagents/cyrus/pull/1624))
**Goal:** Publish an immutable OIDC test candidate for the Anthropic SDK 0.3.332 update and provide the exact `cyrus-core` pin required by Hosted.

## Candidate payload

All 18 public packages carry exact version `0.2.86-test.0`. The feature source updates `@anthropic-ai/claude-agent-sdk` to 0.3.332 and `@anthropic-ai/sdk` to 1.14.0, restores the three MCP resource tools removed after 0.3.268, preserves the shell/path/MCP/security compatibility fixes reviewed across 0.3.323–0.3.331, and adds deterministic credential-free tool extraction.

The candidate uses the coordinated `release-cli.yml` test-channel OIDC path from `main`. The coordinated graph is required by the canonical workflow even though Hosted consumes only `cyrus-core`. No git tag or GitHub release is created, and the stable `latest` tag must remain at 0.2.85.

## Runtime acceptance

- Source F1 routed `DEF-1` through the real issue tracker, EdgeWorker, worktree, and ClaudeRunner query path.
- Claude Code 2.1.332 successfully used `Read(package.json)`, then foreground `Bash(pwd)` with timeout `10000`, and returned exactly `SDK_RUNTIME_OK`.
- The issue activity stream coherently recorded elicitation, prompt, acknowledgment, routing, model, Read, Bash, and response events. Pagination and search returned the expected subsets.
- The mandatory inventory refresh found 26 native tools plus `ListMcpResourcesTool`, `ReadMcpResourceDirTool`, and `ReadMcpResourceTool`; the 0.3.332 increment adds no further tool-list migration.
- The session stopped and the F1 server shut down cleanly without `session_writes_lost` or an unhandled error.

## Publication gates

- The issue explicitly authorizes a test release. Publication is limited to npm dist-tag `test` through the trusted workflow; no local npm credential or stable-tag mutation is used.
- Frozen strict install, dependency audit, lint, build, package and CLI tests, typecheck, package inspection, and isolated bundle installation must pass before publication.
- Registry verification must confirm `cyrus-core@0.2.86-test.0`, the coordinated graph, unchanged non-target tags, and clean installs on npm 10, 11, and 12.
- Hosted must pin the exact registry-backed core version, retain the refreshed Linear/GitHub tool defaults and preservation migration, and pass its own migration, tests, lint, typecheck, build, and audit gates.
