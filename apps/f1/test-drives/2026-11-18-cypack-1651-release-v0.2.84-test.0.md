# CYPACK-1651: Cyrus 0.2.84-test.0 candidate verification

**Date:** 2026-11-18
**Feature source:** `16607a1a211a7d3af933632fef97cd1c30436154` (`cyrusagents/cyrus#1609`)
**Goal:** Prepare an immutable, fully version-stamped OIDC test candidate for the Anthropic SDK update without authorizing publication.

## Candidate payload

All 18 public packages carry exact version `0.2.84-test.0`. The feature source updates `@anthropic-ai/claude-agent-sdk` to 0.3.327 and `@anthropic-ai/sdk` to 1.10.0, refreshes the Claude tool inventory, and reconciles Claude Code 2.1.327 shell-startup, path/worktree, unattended worktree-exit, and MCP behavior against current `main`.

The candidate retains the complete canonical package graph and is intended for the `release-cli.yml` test-channel path from `main`, using its full immutable candidate SHA and npm trusted publishing. No npm login, token publication, or stable-tag mutation is authorized by this preparation.

## Verification

- pnpm 10.33.1 strict frozen install completed with an unchanged lockfile.
- The full workspace build and typecheck passed.
- 101 focused Claude runner and EdgeWorker tests passed for environment precedence, permissions, top-level MCP configuration, sandbox policy, and absolute worktree paths.
- The mandatory Claude tool extraction remains 26 clean built-ins plus the three dynamic MCP resource-discovery tools.
- The feature F1 drive initialized Claude Code 2.1.327, delivered the expected tool registry and activity lifecycle, and stopped cleanly.
- GitHub CI passed all four Node 22/24 checks on the reconciled feature source.

## Held gates

The final installed configured-sandbox receipt remains required before publication: successful ordered `Read(package.json)`, foreground sandboxed `Bash(pwd)` with timeout exactly `10000`, exact final text `SDK_RUNTIME_OK`, no error or `session_writes_lost`, and a clean stop. The retained verifier binds the exact candidate source, packed/installed core and runner, consumer lock, native binary/version, configuration directories, OS user, auth method, provider, and intended account digest before any provider request. It rejects provider/account override variables.

The existing on-host Claude authorization is revoked. A human handoff may refresh only the preserved on-host configured identity; no off-host credential refresh, generic PATH login, alternate account, event publication, or npm publication is part of this candidate-preparation step.
