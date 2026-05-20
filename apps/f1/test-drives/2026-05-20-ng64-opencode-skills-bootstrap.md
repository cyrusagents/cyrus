# Test Drive: NG-64 OpenCode skills bootstrap

**Date**: 2026-05-20
**Goal**: Validate that OpenCode sessions can load Cyrus skills, including `/using-superpowers`, through the runtime config directory.
**Test Repo**: `/tmp/f1-ng64-opencode-skills-20260520`

## Verification Results

### Issue-Tracker
- [x] Issue created
- [x] Issue ID returned
- [x] Issue metadata accessible

### EdgeWorker
- [x] Session started
- [x] Worktree created
- [x] OpenCode runner selected via `[agent=opencode]`
- [x] Activities tracked
- [x] Agent processed issue

### Renderer
- [x] Activity format correct
- [x] Search works

## Session Log

```bash
cd apps/f1
./f1 init-test-repo --path /tmp/f1-ng64-opencode-skills-20260520

CYRUS_PORT=3614 CYRUS_REPO_PATH=/tmp/f1-ng64-opencode-skills-20260520 \
  node apps/f1/dist/server.js

CYRUS_PORT=3614 ./f1 ping
CYRUS_PORT=3614 ./f1 status
```

Server started on `http://localhost:3614`, using Cyrus home `/var/folders/_r/fld8l71j7ts635hlb5vtgnb80000gn/T/cyrus-f1-1779278023405`.

First issue omitted `[repo=...]` and correctly triggered repository selection. The passing run used an explicit repo selector:

```bash
CYRUS_PORT=3614 ./f1 create-issue \
  --title "NG-64 OpenCode skills bootstrap smoke with repo" \
  --description $'Use /using-superpowers, then read README.md and reply exactly: F1_OPENCODE_SKILL_OK\n\n[repo=f1-test-repo]\n[agent=opencode]'

CYRUS_PORT=3614 ./f1 start-session --issue-id issue-2
CYRUS_PORT=3614 ./f1 view-session --session-id session-2 --limit 20 --offset 0
CYRUS_PORT=3614 ./f1 view-session --session-id session-2 --search using-superpowers
```

Key outputs:

- `RepositoryRouter` selected `F1 Test Repository` via `[repo=...]`.
- Activity timeline included `Using model: opencode`.
- Activity timeline included an OpenCode `skill` action with `using-superpowers`.
- Activity timeline included a `Read` action for `README.md`.
- Final response activity was `F1_OPENCODE_SKILL_OK`.

## Final Retrospective

Pass. The F1 run validates the end-to-end path that failed in the Linear retest: OpenCode can now load `/using-superpowers` as a skill, proceed to read from the worktree, and post the expected final response.

## Follow-Up: Empty Default Tool Regression

After the live NG-69 retest, the remaining blocker was narrowed to CLI startup configuration rather than OpenCode's runtime config syntax. The normal CLI path populated `defaultAllowedTools` with an empty array when `ALLOWED_TOOLS` was unset. That empty array was then treated as an explicit policy, leaving OpenCode sessions with only workspace MCP tools (`mcp__linear`, `mcp__cyrus-tools`, `mcp__cyrus-docs`) and no built-in filesystem/shell/skill tools.

Regression coverage was added in `EdgeWorker.multi-repo-tools.test.ts` to prove an empty global default is treated as unset for repository sessions. The expected fallback is the safe built-in tool set plus workspace MCP tools, which restores `Read`, `Skill`, and related repository tools for OpenCode-selected issues.
