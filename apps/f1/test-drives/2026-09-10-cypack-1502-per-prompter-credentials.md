# Test Drive: Per-Prompter Credentials (CYPACK-1502)

**Date:** 2026-09-10
**Branch:** `cypack-1502`
**Scope:** Two-prompter credential resolution, concurrency, follow-up-by-other-user,
unmapped / non-human / unreadable-mapping failure paths, and a real-provider
check of the per-session environment.

This drive separates **local/mock evidence** (F1 in-memory tracker, placeholder
tokens) from **real-provider evidence** (calls that actually reached GitHub or
Claude). No secret values appear anywhere below — only 8-character SHA-256
fingerprints, which is what Cyrus itself logs.

## Harness

F1 gained multi-user support for this drive:

- `f1 create-user --name … --id …` adds humans to the in-memory workspace.
- `f1 start-session --as-user <id>` sets the synthetic webhook's
  `agentSession.creator` (the prompter); `f1 prompt-session --as-user <id>`
  authors the follow-up comment as that user and sets `agentActivity.userId`.
- `CYRUS_F1_CONFIG_OVERRIDES=<json>` merges `linearUsers` /
  `prompterCredentialPolicy` into the F1 EdgeWorker config.

Mapping used (`/tmp/cypack1502-f1/overrides.json`, references only):

| Linear user | Claude credential | GitHub token | Git identity |
| --- | --- | --- | --- |
| `user-ada` (Ada Lovelace) | file ref — **left empty / placeholder** (a real `claude setup-token` is required from Connor; host credential stores are off-limits to the agent) | file ref → the host machine's real `gh auth token` (account `cyrusagent`) | Ada Lovelace `<ada@example.com>` |
| `user-bob` (Bob Builder) | file ref → placeholder `sk-ant-oat01-BOB-…` | file ref → placeholder `github_pat_BOB-…` | Bob Builder `<bob@example.com>` |
| `user-zoe` | not mapped | not mapped | — |
| `cli-app-user` | Cyrus's own app user (non-human trigger) | — | — |

Policy: `unmappedPrompter=reject`, `nonHumanTrigger=reject`,
`followUpByOtherUser=pin` (defaults).

```bash
cd apps/f1
CYRUS_PORT=3611 CYRUS_REPO_PATH=/tmp/cypack1502-f1/repo \
  CYRUS_F1_CONFIG_OVERRIDES=/tmp/cypack1502-f1/overrides.json bun run server.ts
./f1 create-user --name "Ada Lovelace" --id user-ada
./f1 create-user --name "Bob Builder"  --id user-bob
./f1 create-user --name "Zoe Unmapped" --id user-zoe
./f1 create-user --name "Cyrus App"    --id cli-app-user
./f1 create-issue --title "Credential drive" --description "…" --labels primary
./f1 start-session --issue-id issue-1 --as-user user-ada
```

## Run 1 — four prompters, started within 90 ms of each other (concurrency)

Server log (filtered, timestamps stripped):

```
[EdgeWorker] Per-prompter credentials active for 2 mapped Linear user(s)
[GitService] Creating git worktree at /tmp/cyrus-f1-…/worktrees/DEF-1 from local main
[GitService] Creating git worktree at /tmp/cyrus-f1-…/worktrees/DEF-2 from local main
[EdgeWorker] Per-prompter credentials: refusing session session-3 (not-mapped) for Linear user user-zoe
[EdgeWorker] Per-prompter credentials: refusing session session-4 (non-human) for Linear user cli-app-user
[EdgeWorker] Session session-2 runs as Linear user Bob Builder (claude:oauthToken#8e77550e github:bob-placeholder#f47bf441)
[EdgeWorker] Per-prompter credentials: refusing runner for session session-1: Cannot run this session under Ada Lovelace's credentials: Ada Lovelace: Claude credential unreadable — environment variable CLAUDE_CODE_OAUTH_TOKEN is not set. …
error: Claude Code returned an error result: Failed to authenticate. API Error: 401 OAuth access token is invalid.   (session-2 / Bob)
```

Session timelines (`f1 view-session`):

| Session | Prompter | Result |
| --- | --- | --- |
| session-1 | Ada (mapped, Claude ref unreadable in this run) | thought *"Running as Ada Lovelace…"* → response *"Cannot run this session under Ada Lovelace's credentials: … environment variable CLAUDE_CODE_OAUTH_TOKEN is not set …"*. No runner started. |
| session-2 | Bob (mapped, placeholder tokens) | thought *"Running as Bob Builder…"* → runner started → **`error: Failed to authenticate. API Error: 401 OAuth access token is invalid`**. |
| session-3 | Zoe (unmapped) | response *"No execution credentials are mapped for Zoe Unmapped (Linear user user-zoe). Ask the Cyrus operator to run `cyrus add-user` for you, then start a new session."* No worktree. |
| session-4 | `cli-app-user` (non-human) | response *"This session was not started by a mapped human and has no parent session to inherit credentials from, so Cyrus will not run it with the host's credentials…"*. No worktree. |

What this shows:

- **Isolation (real provider, negative proof):** the F1 host authenticates Claude
  sessions successfully in every other test drive. Bob's session failed with a
  **401 from Anthropic** — the child process used Bob's placeholder token and the
  host's working credential was *not* available to it (`omitEnv` removed it).
- **Concurrency:** four sessions created within 90 ms resolved independently to
  four different outcomes; sessions 1 and 2 each got their own worktree and env.
- **Refusals are visible and side-effect free:** sessions 3 and 4 produced a
  `response` activity and no worktree (`ls worktrees` → `DEF-1 DEF-2` only).

## Run 2 — follow-up by another user (pin policy) and unreadable file

```
[GitService] Creating git worktree at …/worktrees/DEF-1 from local main        (Bob's session)
[EdgeWorker] Session session-1 runs as Linear user Bob Builder (claude:oauthToken#8e77550e github:bob-placeholder#f47bf441)
error: … 401 OAuth access token is invalid.                                       (Bob's placeholder token)
```

Ada then commented on Bob's session (`prompt-session --as-user user-ada`):

```
2:14:50 AM  prompt   Ada here — also print the git remote URL.
2:14:50 AM  thought  Prompt from Ada Lovelace applied to a session pinned to Bob Builder's credentials
                     (prompterCredentialPolicy.followUpByOtherUser=pin). Commits, pushes and PRs from
                     this session continue to be attributed to Bob Builder.
2:14:52 AM  thought  Using model: claude/claude-sonnet-5
2:14:54 AM  error    Failed to authenticate. API Error: 401 OAuth access token is…   (still Bob's token)
```

The resume after Ada's prompt re-resolved **Bob's** credentials
(`runs as Linear user Bob Builder … #8e77550e` logged a second time) — the
session stayed pinned. `followUpByOtherUser=reject` is covered by unit tests
(`PrompterCredentialService.test.ts`, `prompter-credentials.test.ts`).

## Run 3 — unreadable mapping is refused before any worktree exists

After adding pre-validation (`PrompterCredentialService.validatePin`) and
emptying Ada's credential file:

```
[EdgeWorker] Per-prompter credentials: refusing session session-1: Cannot run this session under
Ada Lovelace's credentials: Ada Lovelace: Claude credential unreadable — credential file
/tmp/cypack1502-f1/secrets/ada-claude-token is empty. Fix the mapping with `cyrus add-user` / `cyrus check-users`, then start a new session.
```

`view-session session-1` → a single `response` activity with that text;
`worktrees/` → **0 entries**.

## Real-provider check of the per-session environment (GitHub)

`/tmp/cypack1502-f1/gh-actor-check.mjs` builds the exact env overlay Cyrus
injects (`resolveLinearUserCredentials` from `cyrus-core`) and spawns `gh` /
`git` with **no `gh auth` state** (`GH_CONFIG_DIR` pointed at an empty dir):

```
== user-ada (Ada Lovelace) github#2f225b36 claude#5524e907
gh api user (no gh auth, env only) -> login=cyrusagent (exit 0)
git var GIT_AUTHOR_IDENT           -> Ada Lovelace <ada@example.com>
git credential fill                -> username=cyrusagent password=<present, fp 2f225b36>
insteadOf rewrites                 -> git@github.com:   (+ ssh://git@github.com/)
CYRUS_PROMPTER_NAME                -> Ada Lovelace

== user-bob (Bob Builder) github#f47bf441 claude#8e77550e
gh api user (no gh auth, env only) -> error=Bad credentials (exit 1)
git var GIT_AUTHOR_IDENT           -> Bob Builder <bob@example.com>
git credential fill                -> username=bob-placeholder password=<present, fp f47bf441>
insteadOf rewrites                 -> git@github.com:
CYRUS_PROMPTER_NAME                -> Bob Builder
```

- `gh` authenticated **only** from the per-session `GH_TOKEN` and reported the
  token owner (`cyrusagent` — the host's own account, used here as Ada's stand-in
  because no second real PAT was available). Bob's placeholder produced GitHub's
  *Bad credentials*.
- `git credential fill` answered from the per-session helper with each user's
  own token (different fingerprints) — the host's global helpers were not used.
- Author/committer identity and the SSH→HTTPS rewrite came from the session env
  alone; the global git config was untouched
  (`prompter-credentials.test.ts` asserts the same against an empty
  `GIT_CONFIG_GLOBAL`).

## Local unit coverage

- `packages/core/test/prompter-credentials.test.ts` — schema (references only,
  literal secrets rejected), env construction for OAuth vs API key, two users →
  disjoint credentials, all policy branches, helper install, and **real `git`**
  honouring the env (identity, credential fill, insteadOf, no global mutation).
- `packages/edge-worker/test/PrompterCredentialService.test.ts` — prompter
  extraction from created/prompted webhooks, non-human detection, pin/resolve,
  rotation picked up on resume, secret-free errors, host opt-in, follow-up
  policies, parent inheritance, pre-validation.
- `packages/edge-worker/test/RunnerConfigBuilder.prompter-credentials.test.ts` —
  env/omitEnv injection for Claude, env overlay for OpenCode, refusal for
  Codex/Cursor/Gemini, coexistence with sandbox CA env.
- `packages/config-updater/test/handlers/cyrusConfig.test.ts` — hosted config
  pushes preserve `linearUsers` / `prompterCredentialPolicy`.
- `apps/cli/src/services/UserCredentialService.test.ts` — 0600/0700 storage,
  GitHub actor verification, Linear lookup, secret-free inspection.

## Not proven here (needs real credentials from Connor)

1. **Positive Claude path as a distinct user** — needs a real `claude setup-token`
   for a second account. The mechanism is exercised (token injected, host
   credential removed, 401 when the token is bad) but a successful run under a
   *different* subscription was not observed.
2. **PR authored by a different GitHub account** — needs a second real fine-grained
   PAT. `gh api user` under the injected env is proven; opening a PR as user B
   while the host is user A was not observed.
3. **Linear attribution** — activities are posted as the Cyrus app (SDK 60's
   `AgentActivityCreateInput` has no on-behalf-of field); the session creator is
   the human. Documented as a platform limitation, not verified against a live
   Linear workspace in this drive (F1 is in-memory).

The harness is ready: once two tokens exist, `cyrus add-user` for each, then
re-run Run 1 with `--as-user` per person and check `gh api user` / the PR author
in the resulting session output.
