# CYPACK-1663: final 0.2.87-test.0 candidate receipt

**Date:** 2026-11-26
**Reviewed runtime source:** `db2ff4b1ee95f6a0d44475b78f3b93ecfd796c2d` ([cyrus#1628](https://github.com/cyrusagents/cyrus/pull/1628))
**Immutable candidate:** `2df3a1657128d7279dbd25ac81f7ec27697a4876`
**Hosted consumer:** `dd9ae99daa5f6cae330f5b5a77b78d908ed55e4a` ([cyrus-hosted#1484](https://github.com/cyrusagents/cyrus-hosted/pull/1484))

## Publication and package provenance

- The coordinated OIDC test-channel workflow passed candidate validation, frozen strict install, audit, lint, build, package and CLI tests, typecheck, provenance stamping, canonical graph inspection, isolated bundle installation, registry verification, unchanged-tag checks, and clean installs on npm 10, 11, and 12. Receipt: [Actions run 45855613140](https://github.com/cyrusagents/cyrus/actions/runs/45855613140).
- `cyrus-core@0.2.87-test.0` has registry SHA256 `0408673825d34031137c0f27270dfaca04f84d22980003c67a66b5ec2b01aa64`.
- `cyrus-claude-runner@0.2.87-test.0` has registry SHA256 `1cfb3ddbb263c6857f2e8eb1021dd60a385f2752e62f5d61ddf8f5530783c4ea`.
- Both manifests carry `cyrusTestRelease.sourceSha=2df3a1657128d7279dbd25ac81f7ec27697a4876`, version `0.2.87-test.0`, and channel `test`. The runner depends on the exact same core candidate.
- The `test` tags point to `0.2.87-test.0`; the stable `latest` tags remain `0.2.86`. No git tag, GitHub release, or stable publication was created.

## Synthetic-message repair proof

- The registry tarball contains `StreamingPrompt.addMessage(content, options)`, its declaration exposes `options.isSynthetic`, and `ClaudeRunner.addStreamMessage` forwards those options.
- Executing the registry-published `StreamingPrompt.addMessage("automated CI relay", { isSynthetic: true })` emitted a user message with `"isSynthetic": true`.
- This is a new immutable package. The prior `0.2.86-test.0` negative receipt remains preserved and is not claimed to contain the repair.

## Hosted consumer proof

- Hosted pins `cyrus-core@0.2.87-test.0`; its frozen `bun.lock` SHA256 is `64c8d67544df9a75bdcdcb5e9faec5dab090af8ce32a274aa659cfa79bbbbafd`.
- The installed core manifest matches the candidate source stamp, and the installed JS and declarations contain the synthetic-message support.
- Focused validation, default-tool, and migration tests passed 17/17. The full Hosted suite passed 4/4 Turbo tasks; lint, 11/11 typecheck tasks, zero-vulnerability audit, and diff checks passed.

## Open owner gates

- Installed runtime acceptance remains blocked before `Read(package.json)` by the expired OAuth for the preserved `agentops` Claude account. Supported same-account reauthentication is required before the configured-sandbox `Read(package.json)` → foreground `Bash(pwd, timeout 10000)` → exact `SDK_RUNTIME_OK` sequence can be rerun. No alternate identity, provider, configuration, or sandbox is permitted.
- Hosted final-head application CI remains an administrator/owner gate. Workflow `185769570` is `disabled_manually`; the three skipped preview jobs are not application CI. No workflow, billing, authorization, or protection setting was changed.
