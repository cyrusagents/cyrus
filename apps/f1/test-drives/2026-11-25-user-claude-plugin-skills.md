# Claude Code user plugin skills

**Date** November 25, 2026

The drive used the PR implementation from the `codex/claude-installed-plugin-skills` branch, a temporary Git repository, an isolated Claude profile, and a local mock Messages API. It ran the real Claude Agent SDK and Skill tool through the F1 issue and session workflow.

## Setup

- Installed a local marketplace and its example plugin with `claude plugin marketplace add` and `claude plugin install`. The plugin used the standard `skills/example-check/SKILL.md` layout.
- Built the EdgeWorker dependencies with `pnpm -r --filter 'cyrus-edge-worker...' build` and the F1 CLI with `pnpm --filter cyrus-f1 build`.
- Started `bun run apps/f1/server.ts` with a temporary `CLAUDE_CONFIG_DIR` and localhost `ANTHROPIC_BASE_URL`. Started issues routed to the test repository using `f1 create-issue` and `f1 start-session`. The local model fixture requested `Skill` with `example:example-check`.

## Results

| Scenario | Observed |
| --- | --- |
| Opt-in on and plugin enabled | The model request included the qualified skill and Claude accepted its invocation. The F1 session recorded the Skill action and fixture response. |
| Opt-in on and plugin disabled through Claude Code | The next session omitted the skill and rejected the invocation. |
| Opt-in unset and plugin enabled | The session omitted the skill and rejected the invocation with the skills allowlist error. |
| Cyrus-managed skill scoped to an unrelated repository | It stayed absent from the enabled session. |

The drive exercised the local Claude and Cyrus path with a fixture marketplace and a mock model endpoint.
