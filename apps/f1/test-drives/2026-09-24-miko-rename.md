# Miko naming and source-installation verification

**Date:** 2026-09-24
**Goal:** Verify the breaking rename to Miko and the move to `mikoagents/miko`.
**Test repository:** `/tmp/miko-rename-f1-20260924`

## F1 verification

- Started the renamed F1 server with `MIKO_PORT=3600` and `MIKO_REPO_PATH`.
  Health and status checks passed; the server reported ready.
- Created `issue-1` / `DEF-1` and started `session-1`. Selected the test
  repository when the router requested a choice.
- The new `miko-setup.sh` hook ran in the isolated worktree, printed
  `MIKO_SETUP_HOOK_OK`, and wrote a `.miko-hook-ok` marker containing `ready`.
  Hook start and completion appeared as action activities.
- A real Cursor session selected by `[agent=cursor]` and
  `[model=cursor-grok-4.7-xhigh-fast]` read the README and hook marker.
  The first file-read attempt encountered the existing tool permissions;
  the allowed Bash tool succeeded. The final response reported
  **Simple Rate Limiter** and `ready` without changing source files.
- Paginated activity inspection returned 11 timestamped activities including
  routing, hook execution, model selection, a tool action, and the final response.
- The board snapshot reported `status: completed`, `model: grok-4.7`,
  `reasoningEffort: xhigh`, and `fastMode: true`.
- New `/api/update/miko-config`, `/api/update/miko-env`, and `/mcp/miko-tools`
  routes were registered. Stopped the session via F1.
- The first test wrapper forwarded SIGINT twice, causing duplicate lock cleanup.
  Repeated server startup/health/shutdown with an isolated child process group:
  one SIGINT saved worker state, stopped the HTTP server, and exited successfully.

## Automated verification

- Frozen-lockfile installation, full workspace build, and typecheck passed.
- A separate clean source copy, with no old `node_modules` or build artifacts,
  passed frozen installation and the full build.
- Package suites: 2,064 passed, two skipped. CLI suites: 129 passed.
- Source-installer tests: four passed. Normalized the fixture's temporary path
  through `realpath` so macOS `/var` aliases match the launcher's resolved paths.
- The source launcher's artifact and workspace-resolution verification passed.
- CLI smoke checks confirmed `miko` help, `MIKO_HOME`, environment loading of
  `MIKO_REPOS_DIR`, the empty-config setup diagnostic, and rejection of the old
  home flag. Checks used an isolated temporary configuration directory.
- Release metadata validation passed for all 17 renamed release packages.
- Initial lint passed with 47 pre-existing warnings. The commit hook later
  standardized optional-chain guards in four runner wrappers; their affected
  suites were rerun successfully.
- Official npm audit reported no known vulnerabilities. The configured mirror
  lacked an audit endpoint, so the audit explicitly used `registry.npmjs.org`.
- Skill symlinks resolve, and the diff has no whitespace errors.

## Scope

No npm release was published, no external issue was created, and no installed
worker was restarted or migrated. Historical test reports and changelogs retain
their original names; current code and documentation use Miko, with old names
listed only where needed to explain the breaking migration.
