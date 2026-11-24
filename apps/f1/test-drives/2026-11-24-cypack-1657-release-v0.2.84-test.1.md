# CYPACK-1657: Cyrus 0.2.84-test.1 candidate verification

**Date:** 2026-11-24
**Feature source:** `d5f2c7edf0e2a2a0f5e0ac0d8a466c05b9ad8765` (`cyrusagents/cyrus#1620`)
**Goal:** Prepare and publish an immutable, fully version-stamped OIDC test candidate for the Anthropic SDK 0.3.331 update.

## Candidate payload

All 18 public packages carry exact version `0.2.84-test.1`. The feature source updates `@anthropic-ai/claude-agent-sdk` to 0.3.331 and `@anthropic-ai/sdk` to 1.13.0, refreshes the Claude tool inventory, preserves the shell/path/MCP/security compatibility fixes, and records the Claude Code 2.1.331 behavior dispositions and sanitized source-runtime evidence.

The candidate retains the complete canonical 18-package graph and is published through the `release-cli.yml` test-channel OIDC path from `main`, using its full immutable candidate SHA and npm trusted publishing. The coordinated graph is required by the canonical workflow even though Hosted consumes only `cyrus-core`. Candidate `0.2.84-test.0` was published successfully and passed clean installs on npm 10 and 11, but npm 12 rejected its remote `node-forge` tarball dependency with `EALLOWREMOTE`. Candidate `0.2.84-test.1` replaces that dependency with registry-published `node-forge` 1.4.4 and is a fresh immutable identity. The stable `latest` tag must remain unchanged.

## Verification

- The issue explicitly authorizes a test release for this update. Publication is limited to the npm `test` channel through the trusted release workflow; no local npm credentials or stable-tag mutation are used.
- A strict workspace install, complete build, typecheck, lint, package and CLI tests, dependency audit, canonical release validation, all package packs, and isolated bundle install are required to pass before publication.
- The focused Claude runner and EdgeWorker runtime tests cover environment precedence, permissions, sandbox policy, absolute worktree paths, credential-free 26+3 tool extraction, and the registry-backed cryptography dependency.
- Provenance binds the candidate and feature commits, runner/core artifacts, consumer lock, bundled Claude Code 2.1.331 binary, preserved configuration, enabled sandbox policy, OS user, auth method/provider, and intended account digest. Installed core and runner must carry the exact OIDC workflow `cyrusTestRelease` stamp; artifact and consumer-lock hashes are recorded outside the candidate after packing so the candidate SHA is not self-referential.
- After publication, registry verification must confirm `cyrus-core@0.2.84-test.1`, the coordinated package graph, the `test` dist-tag, an unchanged `latest` dist-tag, and clean installs on the supported Node/npm matrix including npm 12.

## Hosted acceptance gate

After registry verification, Hosted must pin the exact registry-backed `cyrus-core@0.2.84-test.1`, refresh its Bun lockfile and tool inventory migration, and complete its own build, tests, lint, typecheck, and production audit before merge.

The final intended-identity installed configured-sandbox receipt remains a Hosted acceptance gate: successful ordered `Read(package.json)`, foreground sandboxed `Bash(pwd)` with timeout exactly `10000`, exact final text `SDK_RUNTIME_OK`, a non-error result with no `session_writes_lost`, and a clean stop. Any bounded on-host human authentication handoff must preserve the exact candidate, bundled binary, `CLAUDE_CONFIG_DIR=/Users/agentops`, empty secure-storage override, OS user, auth method/provider, and intended account digest. No generic PATH login, off-host credential refresh, alternate account, or stable npm publication is part of this candidate.
