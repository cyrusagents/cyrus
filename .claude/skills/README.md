# Agent skills (Tier 2)

Progressive disclosure for agent docs:

| Tier | Location | When loaded |
| --- | --- | --- |
| 1 | Root `AGENTS.md` (symlinked as `CLAUDE.md`) | Always |
| 2 | Skills here / `skills/` | On matching task |
| 3 | `agent-docs/`, `docs/`, nested `CLAUDE.md`, `CONTEXT.md` | When a skill or Tier-1 table points there |

## Canonical source

Workflow playbooks live in **`skills/<name>/SKILL.md`**. This directory
(`.claude/skills/`) mostly contains **symlinks** into `skills/`, plus any
Claude-only skills.

After adding or renaming a skill under `skills/`:

```bash
./scripts/symlink-skills.sh
```

That also wires `.codex/skills` and `.opencode/skills`.

## Index

### Workflow (issue lifecycle)

| Skill | When to use |
| --- | --- |
| `implementation` | Feature, refactor, or PR-review change |
| `debug` | Bug, crash, regression |
| `investigate` | Question / research, no code change |
| `verify-and-ship` | After code changes: checks, changelog, PR/MR |
| `summarize` | Final Linear summary after work completes |

### Product validation

| Skill | When to use |
| --- | --- |
| `f1-test-drive` | End-to-end F1 validation of EdgeWorker behavior |
| `new-agent-harness` | New runner / agent CLI integration |

### Conventions & release

| Skill | When to use |
| --- | --- |
| `core-conventions` | Tests, changelog, deps, skills layout |
| `release` | Full npm publish of packages + CLI |
| `release-core-test` | Publish `cyrus-core@test` for CYHOST dev |

### First-time setup (product install)

| Skill | When to use |
| --- | --- |
| `cyrus-setup` | Full guided install |
| `cyrus-setup-prerequisites` | Node, jq, gh, package |
| `cyrus-setup-claude-auth` | Claude / API auth |
| `cyrus-setup-linear` | Linear OAuth app |
| `cyrus-setup-github` / `cyrus-setup-gitlab` | Git forge auth |
| `cyrus-setup-slack` | Slack app |
| `cyrus-setup-endpoint` | Public webhook URL |
| `cyrus-setup-repository` | Add repos to config |
| `cyrus-setup-launch` | Summary + start agent |

### Claude-only (not under `skills/`)

| Skill | When to use |
| --- | --- |
| `google` | Web search via this environment |

## Tier 3 map

| Path | Contents |
| --- | --- |
| `agent-docs/architecture-and-runtime.md` | Session flow, monorepo, key paths |
| `agent-docs/new-agent-harness.md` | Full harness checklist |
| `agent-docs/dev-gotchas.md` | Config, sandbox, permissions, MCP |
| `agent-docs/testing-and-commands.md` | Commands, prompt-test style |
| `CONTEXT.md` | Domain glossary and seams |
| `packages/CLAUDE.md` | Linear webhook branch rules |
| `apps/f1/CLAUDE.md` | F1 developer guide |
| `docs/` | User-facing setup and config |
| `spec/f1/ARCHITECTURE.md` | F1 system architecture |
