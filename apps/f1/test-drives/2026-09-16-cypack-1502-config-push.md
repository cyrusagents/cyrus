# CYPACK-1502: ConfigUpdater HTTP push and worker hot reload

Date: September 16, 2026 UTC. **PASS — representative-payload local integration.**

Tested runtime: `8800e009ed235342c490153fffbd77ee15c33a78`.
Hosted builder: `d2f68e338652bfc960f1e18e8f51673d143573be`.
[Machine-readable evidence](artifacts/2026-09-16-cypack-1502-config-push.json).

## Setup and protocol

Disposable root: `/private/tmp/cypack1502-config-push-15aiqh_2`, mode 0700.
Fresh repository, OS HOME, Cyrus home, XDG configuration, Git global config and
GitHub CLI config; loopback server on port 3600. Both authorized shared PAT files
were freshly read into the isolated 0600 shared store. Two users were provisioned
with `github.token: {store: "github-tokens"}` and explicit
`followUpByOtherUser: "reject"` before starting the worker. Claude credentials
were not needed; the existing authorized Gemini API key provided model execution.
Slack/Zulip were disabled through the minimal process environment.

A disposable launcher instantiated the built, unmodified EdgeWorker, called its
normal `setConfigPath()` API and started it. ConfigUpdater routes and the config
watcher were real. A read-only observer captured the PID, reload-event count,
selected non-secret settings, mapped UUIDs and effective policy. The stock F1
launcher does not set a watched config path, so using it unchanged would not
exercise this acceptance condition.

The fixture payload was produced by the actual hosted `buildCyrusConfig(...,
"self-host")` function. Only repository/worktree paths and the global setup script
were redirected to disposable local paths (the script exits successfully without
side effects). It omitted `linearUsers` and `prompterCredentialPolicy`. This was
not a request from the hosted UI or hosted production service.

| F1 / integration step | Actual result |
| --- | --- |
| Health and tracker | RPC ping/status succeeded; two mock users and two issues created |
| Baseline A/B | Both sessions started, created worktrees and performed actual `gh api user --jq .login` tool calls: `Connoropolous` / `CyrusLimited` |
| Unauthorized config push | HTTP 401; config unchanged |
| Authorized `POST /api/update/cyrus-config` | HTTP 200; mappings and reject policy exactly equal to their pre-push disk values |
| Real file-watcher reload | Same worker PID 26951; reload count 0 → 1; effective Claude default sonnet → opus and issue-update trigger false → true; both UUIDs and reject policy retained |
| Installation HTTP pushes | Nonempty fixture replacement, empty refresh, then another nonempty fixture all returned HTTP 200; personal entries preserved; store remained 0600 |
| A/B after push and refresh | Concurrent same-user follow-ups each made a **new** gh tool call, again returning `Connoropolous` / `CyrusLimited`; populated installation fixture present |
| B prompts A; A prompts B | Both produced visible owner/reject explanations; zero new actions, including at the final pre-cleanup check |
| Renderer | Thought/action/response content and timestamps valid; CLI table rendered; limit 2 / offsets 0 and 2 returned disjoint activity IDs |
| Cleanup | Both sessions stopped; graceful worker shutdown recorded; port 3600 closed; disposable PAT store and API key removed |
| Secret handling | 108 files scanned for actual secret values and prefixes; zero matches outside the intentionally excluded credential store/API-key files, which were then removed |

The prompt RPC acknowledges receipt even for a policy rejection. The pass criterion
was the subsequent visible refusal and absence of tool execution, not that RPC
acknowledgment. No unexpected error or unhandled-exception log entries occurred.

The deliberately invalid installation fixtures caused two expected, nonfatal
`gh auth login` warnings inside the isolated home. Their writes and preservation
were verified; **valid GitHub App installation authentication was not tested**.
Personal GitHub identity results were real authenticated requests.

## Reproduction and boundaries

The disposable harness used `node` to start the built EdgeWorker and the real F1
`/cli/rpc` methods: `ping`, `status`, `createUser`, `createIssue`, `startSession`,
`viewSession`, `promptSession`, and `stopSession`. HTTP pushes used the real
ConfigUpdater routes with a disposable bearer key. Preservation assertions
compared the disk JSON before/after, then waited for changed effective settings
on the same PID before sending post-push prompts. Evidence includes the actual
four gh action results and both refusal messages.

This closes the representative-payload local HTTP/hot-reload acceptance slice.
It does **not** establish hosted UI-to-runtime end-to-end delivery, live Cursor
success, Codex shell/PR execution, or required-review/no-bypass enforcement.
Earlier Claude/Gemini/OpenCode PR evidence and its limitations remain unchanged.
No implementation change was needed. Internal Cyrus, hosted production, customer
configuration and review rules were untouched; no PR was created, approved or
merged by the test sessions.
