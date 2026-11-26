# CYPACK-1663: Cyrus 0.2.87-test.0 candidate verification

**Date:** 2026-11-26
**Reviewed feature source:** `db2ff4b1ee95f6a0d44475b78f3b93ecfd796c2d` ([cyrus#1628](https://github.com/cyrusagents/cyrus/pull/1628))
**Goal:** Publish a new immutable OIDC test candidate containing the final Anthropic SDK 0.3.332 synthetic-message repair and provide the exact `cyrus-core` pin required by Hosted.

## Candidate payload

All 18 public packages carry exact version `0.2.87-test.0`. The candidate is derived from the independently reviewed PR head and includes `isSynthetic` support in `StreamingPrompt`, `ClaudeRunner`, and the Edge Worker, together with the previously reviewed SDK compatibility changes and MCP resource-tool defaults.

The coordinated `release-cli.yml` test-channel OIDC path publishes the complete canonical graph. No git tag or GitHub release is created, and every stable `latest` tag must remain unchanged.

## Acceptance state

- Source F1 and the prior successful 0.3.331 installed runtime remain historical evidence; they are not claimed as this candidate's installed-runtime receipt.
- The preserved `0.2.86-test.0` installed-runtime attempt is negative evidence: the intended `agentops` Claude OAuth expired before the ordered `Read` step.
- Final installed acceptance remains gated on supported same-account reauthentication, followed by configured-sandbox `Read(package.json)` → foreground `Bash(pwd, timeout 10000)` → exact `SDK_RUNTIME_OK`, a non-error result, no `session_writes_lost`, and a clean stop.
- The release workflow must pass frozen strict install, audit, lint, build, package/CLI tests, typecheck, package inspection, isolated bundle installation, registry verification, and clean npm 10/11/12 installs before publication succeeds.
- Hosted must pin the exact new registry-backed core version and retain its exact-default migration and validation privacy protections.
