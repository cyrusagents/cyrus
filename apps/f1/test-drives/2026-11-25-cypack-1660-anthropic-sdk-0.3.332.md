# CYPACK-1660: Anthropic SDK 0.3.332 / 1.14.0 acceptance

**Date:** 2026-11-25  
**Feature source:** `5a7bb7bce0c493799f96c15d5faaa97cfda9865b` ([cyrus#1624](https://github.com/cyrusagents/cyrus/pull/1624))  
**Test release:** `cyrus-core@0.2.86-test.0`

## SDK and tool disposition

- `@anthropic-ai/claude-agent-sdk` is updated from 0.3.322 to 0.3.332 and `@anthropic-ai/sdk` from 1.7.0 to 1.14.0.
- The 0.3.332 changelog adds plugin rewrite metadata, a `PreSkillShellCommand` hook, automatic-mode mid-turn delivery fixes, and the corrected `setPermissionMode()` return shape. Cyrus requires no additional behavior change for these entries beyond the compatibility work retained from 0.3.323–0.3.331.
- The mandatory inventory refresh found 26 native tools plus `ListMcpResourcesTool`, `ReadMcpResourceDirTool`, and `ReadMcpResourceTool`. The final 0.3.332 increment does not change the 0.3.331 inventory, so the companion Hosted migration retains that reviewed list.

## Source F1

- Routed `DEF-1` through the real issue tracker, EdgeWorker, worktree, and ClaudeRunner query path.
- Claude Code 2.1.332 used `Read(package.json)`, then foreground `Bash(pwd)` with timeout `10000`, and returned exactly `SDK_RUNTIME_OK`.
- The activity stream coherently recorded elicitation, prompt, acknowledgment, routing, model, Read, Bash, and response events. Pagination and search returned the expected subsets.
- The session stopped and the F1 server shut down cleanly without `session_writes_lost` or an unhandled error.

## Package and registry verification

- Strict install, audit, lint, build, typecheck, package tests, CLI tests, package inspection, and isolated bundle installation passed.
- The coordinated OIDC dry run passed in [Actions run 45573131952](https://github.com/cyrusagents/cyrus/actions/runs/45573131952).
- The live test-channel publication and clean installs on npm 10, 11, and 12 passed in [Actions run 45573536723](https://github.com/cyrusagents/cyrus/actions/runs/45573536723).
- Registry verification confirmed immutable `cyrus-core@0.2.86-test.0` under dist-tag `test`; stable dist-tag `latest` remains `0.2.85`.
