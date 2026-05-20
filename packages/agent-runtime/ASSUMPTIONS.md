# Agent Runtime Assumptions

This package is intentionally built as a new standalone runtime layer with minimal dependency on the existing Cyrus runner packages.

## Product Contract

- The package exposes a TypeScript library API first. It does not ship a daemon or CLI in this iteration.
- A session has one Cyrus-owned `sessionId`. Harness-native session identifiers are represented as transcript metadata when a harness emits them.
- Transcript events preserve raw harness JSON whenever possible and wrap it in a stable runtime envelope.
- `addMessage()` queues messages for harnesses that do not support interactive stdin yet. The queue is visible and testable, but delivery is capability-gated.
- `interrupt()` is a soft user-message interruption when supported. `stop()` is lifecycle cancellation and attempts to terminate the running process.

## Harness Contract

- Claude, Codex, Cursor, Gemini, PI, and OpenCode are represented as harness adapters.
- Claude, Codex, Cursor, and Gemini command-line conventions are modeled from locally available CLIs and existing public behavior.
- PI and OpenCode are provisional adapters. Their commands and JSON formats are assumptions until real CLI transcripts are supplied.
- Harness adapters own command construction and transcript parsing. They do not own sandbox provisioning.

## Sandbox Contract

- Local execution is modeled as a sandbox provider. This keeps local and remote execution behind the same conceptual interface.
- ComputeSDK is the vendor abstraction for remote sandbox providers.
- The common ComputeSDK `runCommand()` API is treated as sufficient for one-shot harness runs.
- Streaming process execution is modeled as a capability, but is not assumed for every ComputeSDK provider. Full interactive harness support requires a provider-specific streaming process implementation.
- Volumes, FUSE mounts, snapshots, ports, and network egress are represented in config types even when a provider cannot enforce them yet.
- `RuntimeVolumeConfig.subpath` carries the provider-defined prefix used to scope a shared volume. The Daytona Volumes pattern is the reference use case; other providers map `subpath` as appropriate.

## Session Resume Contract

- The runtime exposes two resume primitives. The caller (Cyrus's `AgentSessionManager`) owns the mapping between its session records and harness-native session ids.
  - `CreateAgentSessionConfig.resumeHarnessSessionId`: caller-supplied prior id. Harness adapters translate it into the right CLI flag (e.g. `--resume <id>` for Claude).
  - `AgentSessionResult.harnessSessionId`: the new harness-native id observed in this run's transcript, surfaced for the caller to persist for next time.
- Harness adapters extract the harness-native session id from transcript events via `extractSessionId(events)`. Claude's `system.init.session_id` is the canonical example.
- The runtime does not persist transcripts itself. For the harness to actually see prior conversation on resume, the caller must arrange durable storage for the harness's config dir — for example by attaching a `RuntimeVolumeConfig` (Daytona Volumes are the reference) mounted at the harness's config path and setting the matching env var (`CLAUDE_CONFIG_DIR` for Claude).
- Daytona's ComputeSDK provider was smoke-tested with a remote working directory of `/home/daytona`; `/workspace` should not be assumed portable across providers.
- Cursor Agent was smoke-tested inside Daytona by installing the CLI with `curl https://cursor.com/install -fsS | bash` and running `/home/daytona/.local/bin/cursor-agent` with `CURSOR_API_KEY` provided as a secret environment variable.
- Codex Agent was smoke-tested inside Daytona far enough to authenticate and start a turn by materializing `~/.codex/auth.json` as a sensitive runtime file. Passing only `OPENAI_API_KEY` from the local Codex auth file produced a remote 401. The authenticated Codex turn later hit the account usage limit.
- Claude Code was smoke-tested inside Daytona by installing the CLI with a user-local npm prefix and running `/home/daytona/.npm-global/bin/claude` with `CLAUDE_CODE_OAUTH_TOKEN` provided as a secret environment variable. The remote session emitted `system`/`assistant`/`result` events and completed successfully.

## Security Contract

- `env` is safe-to-log configuration. `secrets` must be redacted from transcript and error metadata.
- Secrets are passed into process environments only at execution time.
- Tool permissions are represented as declarative runtime config and translated into harness-native flags where currently known.
- Network egress policy is a declarative provider option in this iteration. Enforcement depends on the selected sandbox provider.

## Feedback Loops

- Config schema tests prove the public contract accepts and rejects expected shapes.
- Local sandbox tests prove the local provider can write files and execute commands.
- Harness adapter tests prove command construction and transcript parsing.
- Session runtime tests prove event emission, queueing, stop behavior, and result propagation.
