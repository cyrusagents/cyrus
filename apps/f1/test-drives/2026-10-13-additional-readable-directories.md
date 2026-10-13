# Configurable additional readable directories

Date: 2026-10-13
Base: `9cb20212` plus the uncommitted `sandbox.additionalReadableDirectories` working tree.

## Scenario and setup

Validate operator-configured read-only roots through the real F1 issue,
configuration reload, Claude runner, and activity paths. Use the Claude runner
(`claude-sonnet-5`) with `sandbox.enabled: false`, so only Claude Code tool
permissions apply (no OS sandbox).

Start F1 on port 3600. The F1 repository, `TMPDIR` (and therefore the Cyrus home
and worktrees) were placed under `$HOME`, because home-directory Read
restrictions only apply when an allowed path is inside `$HOME` (see limits). For
this drive, a temporary edit of `apps/f1/server.ts` persisted its config to
`<cyrusHome>/config.json`, called `edgeWorker.setConfigPath(configPath)` right
after constructing the EdgeWorker so hot reload works, and seeded
`sandbox.additionalReadableDirectories` from an env var. The edit was reverted
after the drive (`git diff apps/f1/server.ts` is empty).

Create a fresh test root `~/f1-readable-<random>/` with sibling directories
`allowed/marker.txt` and `denied/marker.txt`, each holding a distinct token.
Start with:

```json
{ "sandbox": { "enabled": false, "additionalReadableDirectories": ["~/f1-readable-<random>/allowed"] } }
```

## Assertions and results

- Read allowed and denied (`DEF-1` / `session-1`): the prompt asked the agent to
  use the Read tool on both markers. The allowed Read returned
  `ALLOWED-TOKEN-A411BDFC-...`. The denied Read failed with
  `<tool_use_error>File is in a directory that is denied by your permission settings.</tool_use_error>`
  (a permission refusal, not a missing file). The runner's allowed tools carried
  `Read(//Users/<user>/f1-readable-<random>/allowed/**)`. PASS.
- Hot reload to `additionalReadableDirectories: []` (config.json rewritten; log:
  `Config file changed, reloading...` / `Global config changes detected`). A fresh
  issue/session (`DEF-2` / `session-2`) asked to Read the previously allowed
  marker. The Read failed with the same `denied by your permission settings`
  error, and the final response was `RESULT: File is in a directory that is
  denied by your permission settings.` PASS.
- Home guard, `"~"` (`DEF-3` / `session-3`): the denied marker stayed denied, but
  no warning was logged (see surprises). The allowed tools gained
  `Read(//<cyrus-cwd>/~/**)`, a path relative to the Cyrus process cwd, which
  is inert. Outcome (no unlock) PASS; warning expectation FAIL for the bare
  `"~"` spelling. Fixed after the drive (see surprises).
- Home guard, `["~/", "<absolute home>"]` (`DEF-4` / `session-4`): the denied marker
  stayed denied, and two warnings were logged:
  `Ignoring sandbox.additionalReadableDirectories entry "~/": it covers the entire home directory`
  and the same for `"/Users/<user>"`. PASS.
- `viewSession` showed timestamped action (Read / Read (Error)) and response
  activities for each session. All four sessions were stopped with `stopSession`,
  and the F1 server shut down cleanly. The test root, F1 workspace, and temporary
  bootstrap were removed.

## Surprises and limits

- An initial run kept the F1 repository and Cyrus home under system tmp
  (outside `$HOME`). Step 1 behaved correctly, but after the hot reload to `[]`
  the allowed marker was still readable. This is because
  `buildHomeDirectoryDisallowedTools` returns `[]` when neither the cwd nor any
  allowed directory is under `$HOME`, so no home deny rules exist at all. The
  behavior predates this change and does not occur for normal
  installs (`~/.cyrus` worktrees). The drive was re-run with the workspace under
  `$HOME`, and the results above come from that re-run. A workspace located
  outside `$HOME` offers no home-directory read protection, with or without this
  feature.
- A bare `"~"` entry is not expanded by `resolvePath` (it only handles the `~/`
  prefix), so it resolves against the process cwd, is not caught by the home
  guard, and logs no warning. It is harmless here but contradicted the "entries
  covering `$HOME` are dropped with a warning" behavior for that spelling.
  Fixed after this drive: `resolveAdditionalReadableDirectories` now maps a
  bare `~` to `$HOME`, so the guard drops it with a warning. Covered by the
  `RunnerConfigBuilder.readable-directories` unit test; not re-driven live.
- Only the Claude runner was exercised live, with the sandbox disabled. Codex,
  Cursor, OpenCode (grants intentionally excluded from `allowedDirectories`) and
  the sandbox-enabled `allowRead` path are covered by targeted unit tests, not by
  this drive. Chat (Slack) sessions share the same builder and were not driven.
