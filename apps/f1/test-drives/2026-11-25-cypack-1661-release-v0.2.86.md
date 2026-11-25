# Enabled Claude Code plugin skills release v0.2.86

**Date** November 25, 2026  
**Runtime code tested** `ef3ea55281e2d3eee1f36243e325fb54e8415a95` (main) plus the release branch's version and changelog metadata  
**Previous release** `v0.2.85`

The only runtime change since v0.2.85 is #1625: with `CYRUS_ENABLE_USER_PLUGIN_SKILLS=1`, `ClaudeRunner` asks `claude plugin list --json` for enabled user-scope plugins and adds their qualified skills (`plugin:skill`) to the session's skills allowlist; pre-warmed sessions are disabled in that mode. If discovery fails, Linear sessions post one fixed warning thought and continue with Cyrus skills. Everything else is version and changelog metadata.

## Drive

Built the release branch with `pnpm build`. Ran `bun run server.ts` from `apps/f1` with a throwaway test repository (`f1 init-test-repo`), an isolated `CLAUDE_CONFIG_DIR` holding a local marketplace and `example` plugin installed with the real `claude plugin marketplace add` / `claude plugin install` (skill `example-check`), and a localhost mock Messages API (`ANTHROPIC_BASE_URL`) that requests the `Skill` tool with `example:example-check`. Issues were created with `f1 create-issue` (`[repo=f1-test-repo]` routing), started with `f1 start-session` and read with `f1 view-session`. The real Claude Agent SDK and Skill tool ran.

| Scenario | Observed |
| --- | --- |
| Opt-in on, plugin enabled | Server log: `Added user plugin skills: example:example-check`. Session activities show the `Skill` action succeeding and the fixture response. |
| Opt-in unset, plugin enabled | No discovery log. The `Skill` action fails (`Skill (Error)`); the session still completes. |
| Opt-in on, `claude` on PATH replaced by a fixture exiting 3 with stderr text | Exactly one fixed warning thought, `Could not list enabled Claude Code plugins. Continuing with ...`, then the session continued. The fixture's raw stderr text appears in neither the server log nor the activities. The skill invocation then fails as expected. |

`pnpm exec vitest run` in `packages/claude-runner`: 159 of 159 passed.

Limitations: the model endpoint is a local fixture and the issue tracker is F1's in-memory adapter; no live provider, Linear delivery, or Hosted/fleet deployment. The mock's skill-detection flag is unreliable (the skill name also appears in the issue text), so the on/off outcome is judged from the Skill action result, not from that flag. The PR's earlier drive (`2026-11-25-user-claude-plugin-skills.md`) additionally covered disabling the plugin through Claude Code and a repository-scoped Cyrus skill; those were not re-run here.
