# CYPACK-1663: installed configured-sandbox runtime for 0.2.87-test.0

**Date:** 2026-11-26
**Feature source:** `db2ff4b1ee95f6a0d44475b78f3b93ecfd796c2d` ([cyrus#1628](https://github.com/cyrusagents/cyrus/pull/1628))
**Immutable candidate:** `2df3a1657128d7279dbd25ac81f7ec27697a4876` (`cypack-1663-test-0.2.87-test.0`)
**Packages:** `cyrus-core@0.2.87-test.0`, `cyrus-claude-runner@0.2.87-test.0`

## Why 0.2.87-test.0

The reused `0.2.86-test.0` artifacts were built from `c544afdd`, before the synthetic-relay repair (`5cd9bd3a`). Their published `StreamingPrompt` drops `isSynthetic`. Those immutable versions were not changed. A new candidate was cut from the reviewed head `db2ff4b1`, which contains the repair, and published through the canonical `release-cli.yml` test-channel OIDC path.

## Publication and provenance

- [Actions run 45855613140](https://github.com/cyrusagents/cyrus/actions/runs/45855613140) completed `test_build`, `test_publish`, and clean installs on npm 10, 11, and 12. Dist-tag `test` is `0.2.87-test.0`; `latest` remains `0.2.86`.
- Both registry manifests carry `cyrusTestRelease.sourceSha = 2df3a165…`. The candidate descends from `db2ff4b1`, which the PR head contains.
- Fresh registry packs are byte-identical to the workflow's inspected publication artifacts:
  - core `0408673825d34031137c0f27270dfaca04f84d22980003c67a66b5ec2b01aa64`
  - runner `1cfb3ddbb263c6857f2e8eb1021dd60a385f2752e62f5d61ddf8f5530783c4ea`
- Consumer lock `60570ec7a8c261a471ad5049fc45596f597838bcb9adb2cd1b730b158d16866a` resolves the runner's `cyrus-core` dependency to exactly `0.2.87-test.0`.
- Published repair check: in the installed `cyrus-core`, `StreamingPrompt.addMessage("automated CI relay", { isSynthetic: true })` emits a user message with `isSynthetic: true`. A following human message carries no `isSynthetic` field. The installed runner's `addStreamMessage(content, options)` forwards `options` to `StreamingPrompt`.

## Installed runtime receipt

Receipt: `evidence/2026-11-26-cypack-1663-installed-sandbox-runtime.json` (status `PASS`).

- The run used the same intended identity as the earlier attempt: OS user `agentops`, config dir `/Users/agentops`, the same account hash, `claude.ai` / `firstParty` / `max`. No provider, token, or config override was set, and no identity was substituted.
- The sandbox matched the configured one: `enabled`, `autoAllowBashIfSandboxed`, `allowUnsandboxedCommands: false`, read/write `.`.
- Runtime: Claude Code 2.1.332 (native `@anthropic-ai/claude-agent-sdk-darwin-arm64@0.3.332`, executable `5b8214f8…`).
- Sequence: `Read(package.json)` succeeded → foreground `Bash(pwd)` with timeout `10000` succeeded → final text exactly `SDK_RUNTIME_OK`.
- Result was `success` with `isError: false` in 4 turns. There was no `session_writes_lost`, and the session stopped cleanly.
- The model first issued `Bash` alongside `Read`. The verifier's ordering hook denied that early attempt (`blockedPrematureAttempts: 1`). `Bash` ran only after `Read` completed.

## Evidence that remains separate

- The **0.2.86-test.0 negative receipt** (`evidence/2026-11-25-cypack-1660-installed-sandbox-runtime-auth-blocked.json`) is retained unchanged. It is `BLOCKED`: the intended `agentops` account failed with an expired OAuth token before `Read`. It does not satisfy acceptance.
- The **prior 0.3.331 installed success** (`evidence/2026-11-24-cypack-1657-installed-sandbox-runtime.json`) is for a different SDK version.
- **Source F1** (2.1.332 at `5a7bb7bc`) predates the synthetic-relay repair. The repair is covered by the `StreamingPrompt` and EdgeWorker relay tests, which passed in the candidate's `test_build`.
