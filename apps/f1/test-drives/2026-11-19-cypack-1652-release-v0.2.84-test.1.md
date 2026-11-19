# CYPACK-1652: Cyrus 0.2.84-test.1 candidate verification

**Date:** 2026-11-19
**Feature source:** `94a4b813297951aa8ef256f53dcb0d8252cf8a19` (`cyrusagents/cyrus#1616`)
**Goal:** Prepare an immutable, fully version-stamped OIDC test candidate for the Anthropic SDK 0.3.328 update without authorizing publication.

## Candidate payload

All 18 public packages carry exact version `0.2.84-test.1`. The feature source updates `@anthropic-ai/claude-agent-sdk` to 0.3.328 and `@anthropic-ai/sdk` to 1.10.0, refreshes the Claude tool inventory, preserves prior shell/path/MCP/security fixes, forces deferred-tool resume and shell-head-start suppression, and records the remaining Claude Code 2.1.328 behavior dispositions.

The candidate retains the complete canonical package graph and is intended for the `release-cli.yml` test-channel OIDC path from `main`, using its full immutable candidate SHA and npm trusted publishing. `0.2.84-test.0` remains the superseded, unpublished 0.3.327 candidate; the new identity is not reused. No workflow dispatch, npm login, token publication, or stable-tag mutation is authorized by this preparation.

## Verification

- The registry contains no `0.2.84` prerelease for core, runner, or CLI at preparation time.
- pnpm 10.33.1 strict frozen install completes with an unchanged lockfile.
- The complete workspace build, typecheck, lint, package tests, CLI tests, dependency audit, canonical release validation, all 18 package packs, and isolated bundle install are required to pass before the candidate is pushed.
- The focused Claude runner and EdgeWorker runtime tests cover environment precedence, permissions, sandbox policy, absolute worktree paths, and credential-free 26+3 tool extraction.
- Provenance binds the candidate and feature commits, runner/core artifacts, consumer lock, bundled Claude Code 2.1.328 binary, preserved configuration, OS user, auth method/provider, and intended account digest. Installed core and runner must carry the exact OIDC workflow `cyrusTestRelease` stamp; artifact and consumer-lock hashes are recorded outside the candidate after packing so the candidate SHA is not self-referential.

## Held gates

Publication remains separately authorized and has not been requested. After publication, Hosted must pin the exact registry-backed `cyrus-core@0.2.84-test.1`, preserve its frozen Bun lock and migration chain, and complete its own CI before merge.

The final intended-identity installed configured-sandbox receipt also remains required: successful ordered `Read(package.json)`, foreground sandboxed `Bash(pwd)` with timeout exactly `10000`, exact final text `SDK_RUNTIME_OK`, a non-error result with no `session_writes_lost`, and a clean stop. Before any bounded on-host human authentication handoff, preserve the exact candidate, bundled binary, `CLAUDE_CONFIG_DIR=/Users/agentops`, empty secure-storage override, OS user, auth method/provider, and intended account digest. No generic PATH login, off-host credential refresh, alternate account, event publication, or npm publication is part of candidate preparation.
