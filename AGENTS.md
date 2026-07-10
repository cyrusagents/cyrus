# AGENTS.md

Guidance for coding agents working in this repository. Keep this file short —
task-specific procedure lives in skills and `agent-docs/`.

## Why

Cyrus connects issue trackers (Linear, GitHub) to AI coding agents (Claude Code,
Cursor, and others). The `cyrus` CLI runs an `EdgeWorker` that receives webhooks,
creates isolated git worktrees per issue, runs agent sessions, and posts
activity back to the tracker. Paid deployments can use CYHOST
(`app.atcyrus.com`) to push config to a self-hosted runtime.

## What

```
apps/cli/          # cyrus-ai CLI
apps/f1/           # End-to-end test framework (CLI platform mode)
packages/core/     # Shared types, config schemas, issue-tracker interfaces
packages/edge-worker/           # Orchestrator (sessions, routing, MCP)
packages/claude-runner/         # Claude Code SDK wrapper
packages/cursor-runner/         # Cursor Agent SDK wrapper
packages/linear-event-transport/
packages/github-event-transport/
packages/mcp-tools/             # cyrus-tools MCP server
packages/config-updater/        # CYHOST remote config
packages/cloudflare-tunnel-client/
skills/            # Canonical agent skills (symlink into harness dirs)
agent-docs/        # Deep agent reference (Tier 3)
docs/              # User-facing setup/config docs
CONTEXT.md         # Domain & architecture glossary
```

**Runtime flow:** webhooks → event transport → EdgeWorker → worktree → runner →
activities posted back. Details: `agent-docs/architecture-and-runtime.md`.

## How (universal rules)

- **Stack:** Node.js >= 22, pnpm >= 10, TypeScript, Vitest, Biome. Never npm/yarn.
- **Ship gate:** `pnpm test:packages:run`, `pnpm typecheck`, `pnpm lint` before PR.
  User-facing changes → `CHANGELOG.md`; internal → `CHANGELOG.internal.md`.
- **Prompt assembly tests:** assert the *entire* expected prompt via
  `.expectUserPrompt()` / `.verify()` — never weak `.toContain()` checks. See
  `agent-docs/testing-and-commands.md`.
- **Major validation:** use F1 test drives (`f1-test-drive` skill), not ad-hoc
  Linear pokes against production workspaces.
- **Skills:** write workflow playbooks under `skills/<name>/SKILL.md`, then
  `./scripts/symlink-skills.sh`. Do not duplicate protocol text across harnesses.
- **Config / sandbox / MCP / SDK bumps:** load `agent-docs/dev-gotchas.md` — silent
  breakage is common (config whitelist, path `~` expansion, dual permission layers).
- **Dependency vulns:** prefer direct-dep bumps in the owning package; use root
  `pnpm.overrides` only as last resort; keep `pnpm audit` clean.

## Progressive disclosure (task → skill / doc)

| Task | Load |
| --- | --- |
| Implement a feature / refactor | `implementation` → then `verify-and-ship` → `summarize` |
| Fix a bug | `debug` → then `verify-and-ship` → `summarize` |
| Question / research (no code change) | `investigate` → `summarize` |
| Ship checks, changelog, PR/MR | `verify-and-ship` |
| F1 end-to-end validation | `f1-test-drive` + `apps/f1/CLAUDE.md` + `spec/f1/ARCHITECTURE.md` |
| New agent CLI harness | `new-agent-harness` + `agent-docs/new-agent-harness.md` |
| Conventions while coding (tests, changelog, deps) | `core-conventions` |
| Config field / sandbox / permissions / MCP catalog | `agent-docs/dev-gotchas.md` |
| Architecture, session flow, key paths | `agent-docs/architecture-and-runtime.md` |
| Commands, prompt-test style | `agent-docs/testing-and-commands.md` |
| Domain vocabulary / seams | `CONTEXT.md` |
| Linear webhook branch rules | `packages/CLAUDE.md` |
| Full product release to npm | `release` |
| Dev-only `cyrus-core@test` publish | `release-core-test` |
| First-time Cyrus install / integrations | `cyrus-setup` (+ `cyrus-setup-*` subskills) |
| User setup docs (self-host, config file, tunnels) | `docs/` |

Skill index: `.claude/skills/README.md`. Canonical bodies: `skills/`.
