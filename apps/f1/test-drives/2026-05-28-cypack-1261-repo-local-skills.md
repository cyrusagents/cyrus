# Test Drive: CYPACK-1261 — Per-repo `.claude/skills/` discovery

**Date**: 2026-05-28
**Goal**: Verify repo-local skills (`<repo>/.claude/skills/*`) are both *whitelisted* and *discovered* by Claude Code — for single-repo (cwd-based) and multi-repo (`--add-dir`-based) sessions.
**Test Repos**: `/tmp/f1-mr-primary-*` (ships `primary-canary-skill`), `/tmp/f1-mr-secondary-*` (ships `secondary-canary-skill`)

## Why this drive

The SDK `skills` flag is a **context filter over *discovered* skills**, not a discovery mechanism (SDK docs: *"a context filter, not a sandbox: unlisted skills are hidden… but their files remain on disk"*). So the open risk was: for multi-repo sessions the cwd is the workspace *container* and each repo lives in a sibling sub-worktree — would whitelisting the names actually surface skills the CLI never scanned? Connor pointed to the Claude Code skills doc: `--add-dir` is the documented exception that auto-loads `.claude/skills/` from each added directory.

## Part A — SDK mechanism probe (deterministic)

Drove the bundled `@anthropic-ai/claude-agent-sdk` `query()` directly and read the `system/init` message's `skills[]` (the CLI's discovered+enabled list, emitted at init before any API turn). Layout: `cwd/` has no skills; `cwd/sub_added/.claude/skills/canary-added-skill`; `cwd/sub_notadded/.claude/skills/canary-notadded-skill`.

| Scenario | `canary-added` (subdir via `--add-dir`) | `canary-notadded` (subdir, not added) |
|---|---|---|
| No `additionalDirectories` | **false** — cwd scan does not recurse | false |
| `additionalDirectories:[sub_added]`, `skills:'all'` | **true** — discovered | false |
| `additionalDirectories:[sub_added]`, `skills:['canary-added-skill']` (Atmiko's shape) | **true** — discovered + enabled | false |

**Conclusion**: `--add-dir <dir>` auto-loads `<dir>/.claude/skills`, *even when `<dir>` is a subdirectory of cwd and cwd has no skills*, and it is *necessary* (no add-dir → not discovered). The subdir nuance I flagged is confirmed safe.

## Part B — Live single-repo F1 session

`ATMIKO_REPO_PATH=<primary>` (ships `primary-canary-skill`), issue created, session started, repo selection resolved.

Captured the `claude_query_options` the EdgeWorker passed to the runner:

```
"skills": [ "verify-and-ship", "investigate", "summarize", "implementation", "debug", "primary-canary-skill" ]
cqo.cwd = .../worktrees/DEF-1            # single-repo cwd == the worktree
(cqo.additionalDirectoryCount absent)     # correct — no extra dirs needed for single-repo
```

The repo-shipped `primary-canary-skill` flows through `discoverSkillNames` into the runner's whitelist **and** the skills-guidance system prompt. Because cwd is the worktree, the CLI discovers `<cwd>/.claude/skills/primary-canary-skill` directly — no `--add-dir` required (and none emitted).

> Note: the subsequent *model turn* errored with `Not logged in` — full API turns need credentials not present in this F1 environment. Skill **discovery** happens at CLI init (what Part A measures) and the **whitelist** is captured pre-turn, so neither validation depends on a completed turn.

## Part C — Multi-repo wiring

F1's CLI router did not honor the `[repos=a,b]` description tag (it fell through to repository *selection*) — an F1 harness limitation, not a product issue — so a fully-live multi-repo agent turn wasn't reachable here. Multi-repo correctness is instead covered by:
- **Part A** — proves the CLI `--add-dir` discovery mechanism for sub-worktrees.
- **Unit test** `RunnerConfigBuilder.additional-directories.test.ts` — proves the EdgeWorker emits `additionalDirectories = session.workspace.repoPaths` values (excluding cwd) for multi-repo, and omits it for single-repo.

## Verification Results

- [x] Single-repo: repo-local skill name in runner whitelist + guidance (live)
- [x] Single-repo: cwd == worktree, so CLI discovers repo skills directly (live telemetry)
- [x] `--add-dir` sub-worktree → `.claude/skills` discovered (SDK probe)
- [x] No `--add-dir` → sub-worktree skills NOT discovered (negative control)
- [x] Multi-repo `additionalDirectories` wiring (unit test)

## Retrospective

The mechanism is sound end-to-end. Follow-up cleanup from this drive: removed a dead `allowedDirectories` SDK query-option spread in `ClaudeRunner` (the SDK never read it; `config.allowedDirectories` is still used for `Read(<dir>/**)` grants + home-dir deny exclusions). Possible future F1 improvement: make the CLI router honor `[repos=...]` description tags so live multi-repo drives are reachable.
