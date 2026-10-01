# Configurable writable tool directories

Date: 2026-10-01
Base: upstream `a9502dd`; implementation: `50e3c22`.

## Scenario and setup

Validate operator-configured tool state directories through the real F1 issue,
configuration reload, runner, and activity paths. Use Codex with the repository's
default model (`gpt-5.5`), with browser support and the network proxy disabled.

Start F1 on port 3600 against a fresh empty Git repository. For this drive, a
temporary copy of `apps/f1/server.ts` persisted its initial config and registered
the config path immediately after constructing the EdgeWorker:

```typescript
const configPath = join(CYRUS_HOME, "config.json");
writeFileSync(configPath, JSON.stringify(config));
edgeWorker.setConfigPath(configPath);
```

The temporary bootstrap was removed after the drive. Create two sibling
directories (`allowed` and `denied`) under a fresh home-directory test root,
outside the workspace and system temporary directories. Hot-reload:

```json
{
  "sandbox": {
    "enabled": false,
    "additionalWritableDirectories": ["~/<test-root>/allowed"]
  }
}
```

## Assertions and results

- RPC `createIssue` and `startSession` created `DEF-2` / `session-2`.
  `promptSession` selected the test repository and started a fresh Codex agent.
- The agent ran a Python standard-library probe. Tempfile create/delete and Unix
  socket bind/unlink in `allowed` passed. A tempfile in `denied` failed with
  `PermissionError: Operation not permitted`. The final response was
  `GENERIC_WRITABLE_ROOT_OK`.
- Hot-reload the same config with `additionalWritableDirectories: []`. A fresh
  issue/session (`DEF-3` / `session-3`) attempted a tempfile in the previously
  allowed directory. It failed with `PermissionError: Operation not permitted`;
  the final response was `WRITABLE_ROOT_REMOVAL_OK`.
- `viewSession` recorded timestamped action and response activities containing
  the probe outputs. Both changed-behavior assertions passed.
- `stopSession` succeeded and the F1 server shut down cleanly. Probe artifacts,
  test directories, and the temporary bootstrap were removed.

An initial session requested a model unsupported by upstream's installed Codex
version. The permission assertions above used `gpt-5.5` and completed successfully.

## Other verification and limits

114 targeted configuration, reload, issue/chat runner, Codex sandbox, and Cursor
sandbox tests passed. Full repository build, type checks, and generated-schema
verification passed through the commit hook.

The live drive tested filesystem enforcement on macOS with Codex. Claude and
Cursor permission plumbing is covered by the targeted tests; their live agent
sessions were not run. No browser startup or hardware acceptance was tested.
