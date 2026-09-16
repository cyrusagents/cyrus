# CYPACK-1502: shared GitHub token store

Date: September 16, 2026 UTC (September 15 Pacific).
Runtime main `e9e1e53d629b023545ebfd821bcd16c67f44f217` merged into the feature at
`8558a173`. Hosted main was also merged at `002fc722`; docs main was already an
ancestor. Connor’s earlier remote main merge `aa4ed2ae` was also reconciled
without a force push; its only conflict was the older changelog layout. Existing
work and CYHOST-913 reference branches were preserved.

## Contract and offline regressions

See [the schema/migration contract](../../../docs/SHARED_GITHUB_TOKEN_STORE.md).
The installation array remains unchanged in a v1 file. Optional `personalTokens`
is keyed by Linear UUID and stores a PAT, env reference, or null revocation marker.
CLI and hosted updates share a cross-process lock and atomic unique 0600 writes.
Git/gh personal selection takes precedence over installation and host fallbacks.

- Two concurrent A/B processes targeting the **same org/repo** receive distinct
  fixture credentials through real Git credential resolution and the session PATH
  `gh` shim. The latter invokes an offline gh fixture; this is not a live PR test.
  Real commits assert both author and committer names/emails.
- Nine independent Node processes perform 108 interleaved personal add/remove
  and installation-refresh writes; both namespaces remain intact.
- Legacy v1 stores and file/env mappings, source preservation, environment
  rotation, revocation tombstones, corrupt-store refusal and 0600 permissions pass.
- Real gh/helper subprocesses refuse missing, empty, revoked and corrupt personal
  selections despite available host and installation credentials.
- Hosted handler tests preserve local personal entries (including on an empty
  installation refresh), ignore hosted attempts to supply personal entries, and
  never authenticate shared gh state using a personal PAT.
- Built CLI add/list/check/remove tests verify canonical references, separate
  Claude storage, no new parallel GitHub secret file, installation preservation,
  and a tombstone on removal.
- Existing org/owner selection, explicit `-R`/`GH_REPO` handling, installation
  consumers, cross-runner and streaming ownership tests remain green.
- Five additional builder cases verify that personal credentials override the
  newly merged installation-token environment path in all five runners.

Validation: full monorepo suite **2,117 passed, 2 skipped**; the subsequently
expanded builder suite **13 passed** (five new cases), and shared-store suite
**12 passed** (including a new lock-timeout/no-deletion case). Build, typecheck and lint
passed; lint reports 12 existing warnings. JSON schemas regenerated and tested.
Dependency audit reports no known vulnerabilities; the public MDX guide compiles.

## Live F1 protocol

Fresh private root `/private/tmp/cypack1502-store-f1-qfgsl2fs` (0700), disposable
repository, isolated Cyrus home and OS HOME; port 3622. Only the existing
Gemini model key and authorized two test PATs were used. PATs were written to the
isolated shared store (0600); the installation array contained an intentionally
invalid offline token, making an accidental installation selection fail visibly.
No internal Cyrus home, model auth, tunnel, GitHub rules or existing draft PR was
changed. The issue tracker is **F1's mock tracker**, not real Linear.

| Protocol step | Observed evidence |
| --- | --- |
| Health / issue creation | RPC ping succeeded; DEF-2/DEF-3 created, with explicit mock users matching the mapped UUIDs |
| Start A/B | session-1 and session-2 accepted 129 ms apart; correct owner thoughts, worktrees and Gemini selection |
| A initial model/tool run | Real `gh api user --jq .login` returned `Connoropolous`; `command -v gh` returned the isolated `scripts/bin/gh` |
| B initial model run | Generic success response with **no tool action**; not counted as identity proof |
| B same-user follow-up | Actual tool call returned `CyrusLimited` and the same isolated shim path |
| B prompts A under reject | Visible refusal naming the assigned owner; no added action or runner execution for that request |
| Installation refresh | `GitHubTokenStore.save` replaced only installation entries; both personal entries remained |
| Concurrent A/B follow-ups after refresh | Real gh tool calls returned `Connoropolous` and `CyrusLimited`, respectively |
| Revoke A in disposable store | A's next prompt produced “personal GitHub credentials are missing or revoked”; no new action/input execution, while B and installations remained |
| Renderer | Thought/action/response content and timestamps validated; CLI table displayed correctly; offset/limit pagination returned different activities |
| Cleanup | Both sessions stopped successfully; server terminated; port confirmed closed |

Initial harness requests needed the current F1 `createUser` step and `message`
parameter; these validation failures did not start runners. Seven saved evidence
files were scanned against actual credential values: no raw-secret matches.
Credential stores themselves were excluded from that evidence scan.

## Proof boundaries

This drive proves live model-to-GitHub identity resolution via the integrated
store and wrappers, including refresh and refusal. It did not push or create new
PRs, change review rules, approve or merge. Preserve the earlier Claude draft
[PR 11](https://github.com/CyrusAgentTesting/test/pull/11) /
[PR 12](https://github.com/CyrusAgentTesting/test/pull/12) evidence and
[Gemini/OpenCode PR 13–16 evidence](2026-09-12-cypack-1502-live-nonclaude.md).
The two Claude tokens still belong to one underlying account.

Live Cursor success/start-stop-resume needs a valid Cursor SDK API key; the
available key was rejected in the earlier drive. Codex needs the isolated
acceptance script run outside the outer Mac sandbox so its own workspace sandbox
can start. Existing offline lifecycle/error tests remain green. Required-review
and no-bypass behavior still need repository-owner confirmation and a human
review exercise; no merging or bypass is authorized.
