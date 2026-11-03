# CYPACK-1603 Cursor SDK Runtime Acceptance

**Date**: 2026-10-27
**Result**: PASS — Cursor SDK 1.1.0 create, provider tools/results, continuation, state reuse, and clean stop completed after supported same-account credential recovery
**Goal**: Exercise Cursor SDK 1.1.0 create, tool/result, continuation, and stop behavior after removing its vulnerable Zod dependency.
**Tested source commit**: `b4826fae8b15675a069856105f1c30387155dd01`
**Installed SDK**: `@cursor/sdk` 1.1.0
**Test repository**: `/private/tmp/cypack-1603-final-20261027`
**F1 home**: `/tmp/cyrus-f1-1793127117529`
**Session**: `session-1` / issue `issue-1` (`DEF-1`)

## Verification Results

- [x] F1 server started on port 3600, reported healthy, and created the issue and session.
- [x] Repository selection created `/tmp/cyrus-f1-1793127117529/worktrees/DEF-1`.
- [x] The `[agent=cursor] [model=default]` selectors routed through Cursor SDK 1.1.0.
- [x] Create and continuation both installed worktree-scoped permission hooks.
- [x] Create and continuation both opened the same SQLite store under the fixture-owned Cyrus home.
- [x] `index.db` was created under that store; neither path attempted to write under global `~/.cursor`.
- [x] `Agent.create()` completed and emitted provider tool/result receipts.
- [x] The requested create proof file was written and read.
- [x] `Agent.resume()` completed against the same persisted agent and emitted provider tool/result receipts.
- [x] The requested continuation proof file was written and read.
- [x] Stop completed, permission hooks were removed, and port 3600 closed after graceful server shutdown.

## Initial Blocked Attempt

The real Cyrus start path selected the intended worktree and opened the SDK store at the expected SHA-256-keyed location:

```text
[CursorRunner] Installed Cyrus permission hooks at /tmp/cyrus-f1-1793085658994/worktrees/DEF-1/.cursor/hooks.json (allow=30, deny=3342, backup=no)
[CursorRunner] Opened Cursor SDK state store at /tmp/cyrus-f1-1793085658994/cursor-sdk-state/69f929c8c826f6c714f4664b935a8f715e185ba43d66e27ad0a52478e3b94cf9
```

`index.db`, `index.db-shm`, and `index.db-wal` were present in that directory. `Agent.create()` then reached Cursor's authenticated model lookup and failed before provider execution:

```text
AuthenticationError: Invalid User API Key
status: 401
endpoint: GET /v1/models
requestId: cae47b74-a28e-4c0e-83ab-70c56a27ec59
operation: Agent.create
```

No credential, account, sandbox policy, or live runtime was changed. The requested `cursor-f1-proof.txt` was absent, and the session timeline correctly rendered the authentication error.

The continuation path reused the same worktree and state root before attempting the existing Cyrus session ID:

```text
[resumeAgentSession] needsNewSession=false, resumeSessionId=3f8f41d4-9b7d-425f-a54a-2666e90cb8bb
[CursorRunner] Opened Cursor SDK state store at /tmp/cyrus-f1-1793085658994/cursor-sdk-state/69f929c8c826f6c714f4664b935a8f715e185ba43d66e27ad0a52478e3b94cf9
[CursorRunner] Resuming agent 3f8f41d4-9b7d-425f-a54a-2666e90cb8bb
AgentNotFoundError: Agent 3f8f41d4-9b7d-425f-a54a-2666e90cb8bb not found
operation: Agent.resume
```

The initial authentication failure prevented `Agent.create()` from returning and persisting an SDK agent, so the resume target did not exist and no provider tool/result receipts or continuation proof file could be produced.

## Credential-Source Follow-up

The follow-up review of exact head `1d6a228fc9ba6887c337a8041c1865313b25b89a` found no supported evidence that the configured credential or its intended account changed after this run:

- `agent status --format json` reports `unauthenticated`, with no access or refresh token.
- `agent about --format json` reports no user email, subscription tier, or last request ID, so the Cursor CLI has no authenticated account identity that can safely be inferred or reused.
- Cyrus loads its default operator environment from `<cyrusHome>/.env`, copies `CURSOR_API_KEY` into the Cursor runner configuration, and passes that explicit user-supplied key to the SDK.
- The configured file is `/Users/agentops/.cyrus/.env`, mode `0600`, owned by the `agentops` OS account, and last modified at `2026-10-21T16:56:34-0700`, before the failed provider requests. No credential value was read or printed.
- Repository, PR, fixture, and post-run Linear session receipts contain no newer successful Cursor create/tool-result/continuation run.

Connor subsequently identified the intended Cursor account directly as `connorturland@gmail.com`. This resolves account ownership only: it does not establish that the currently configured key belongs to that account or that authentication has recovered. No other identity may be substituted.

The requested human-only recovery action was:

1. Connor signs in to the Cursor Dashboard as `connorturland@gmail.com` and generates a user API key under **Dashboard → API Keys**.
2. The operator responsible for `/Users/agentops/.cyrus/.env` replaces the existing `CURSOR_API_KEY` value with that key through the secure operator channel, without posting or logging the value, and preserves the file's `0600` permissions.
3. The operator confirms Cyrus logged the existing `.env` watcher reload. `Application` reloads that file with override semantics, so this path does not require a global Cursor CLI login or a different identity.

Cursor documents API keys through `CURSOR_API_KEY` as the supported automation/CI flow at <https://cursor.com/docs/cli/reference/authentication>.

Connor then replaced `CURSOR_API_KEY` in that exact file with a new key for the intended account. The already-running acceptance session still inherited the old environment value, and a private equality check confirmed it did not match the updated file. No key value or fingerprint was emitted. Rather than restart Cyrus globally, the one bounded F1 child loaded `CURSOR_API_KEY` directly from `/Users/agentops/.cyrus/.env` and asserted internally that its effective value matched the file before starting.

The generic phrase “operator `.env`” and `/Users/agentops/.cyrus/.env` refer to the same source: Cyrus resolves the default environment path as `<cyrusHome>/.env`, with `cyrusHome` set to `/Users/agentops/.cyrus` for this runtime.

## Final Acceptance Evidence

The final-head child reported only non-secret credential metadata:

```text
acceptance_credential_source=/Users/agentops/.cyrus/.env
acceptance_file_key_present=true
acceptance_child_matches_file=true
```

The create turn opened the fixture-owned store, created an SDK agent, emitted real provider actions/results for reading `package.json`, running `pwd`, writing the proof file, and reading it back, then completed successfully:

```text
[CursorRunner] Opened Cursor SDK state store at /tmp/cyrus-f1-1793127117529/cursor-sdk-state/417a31280ab2fd54a837fcc5d89ba0bfdfe3921a7c886b84aa46400c0e7650bd
[CursorRunner] Sending prompt to agent agent-3cf575ab-55f6-4ed4-aa48-89a0bd2ef50b (resume=false)
Session completed (subtype: success)
cursor-f1-proof.txt: CREATE_OK
response marker: CURSOR_F1_CREATE_OK
```

The continuation reused that exact store and persisted agent, emitted another real provider action/result, appended the second proof line, and completed successfully:

```text
[resumeAgentSession] needsNewSession=false, resumeSessionId=agent-3cf575ab-55f6-4ed4-aa48-89a0bd2ef50b
[CursorRunner] Opened Cursor SDK state store at /tmp/cyrus-f1-1793127117529/cursor-sdk-state/417a31280ab2fd54a837fcc5d89ba0bfdfe3921a7c886b84aa46400c0e7650bd
[CursorRunner] Resuming agent agent-3cf575ab-55f6-4ed4-aa48-89a0bd2ef50b
[CursorRunner] Sending prompt to agent agent-3cf575ab-55f6-4ed4-aa48-89a0bd2ef50b (resume=true)
Session completed (subtype: success)
cursor-f1-proof.txt: CREATE_OK / CONTINUATION_OK
response marker: CURSOR_F1_CONTINUATION_OK
```

The rendered timeline contained 16 coherent activities including repository elicitation, prompts, `cursor/default` model notices, thoughts, provider actions, and both final responses. Pagination returned the requested window. Stopping the session removed `.cursor/hooks.json`; SIGINT then saved EdgeWorker state, stopped the shared server gracefully, and released port 3600.

The controlled evidence establishes that the old configured credential was rejected with `401` while the newly installed same-account credential authenticated successfully against the same final code and SDK. It does not establish why the old credential was rejected. Revocation, expiry, key type, and account mismatch remain unproven.

## Merge Coordination

Merge #1563 first now that provider acceptance has succeeded. Then rebase #1564 onto the resulting `main` and drop its overlapping Cursor 1.0.40/scalar-`cwd` dependency and runner hunks. The reconciled #1564 must inherit SDK 1.1.0 and preserve the accepted `cyrusHome`-scoped, SHA-256 workspace-keyed `SqliteLocalAgentStore` on create and resume, store disposal, tests, and the zero-advisory dependency graph.

## Disposition

The SDK 1.1.0 compatibility change is accepted on the actual Cyrus create and continuation paths: scalar `cwd`, fixture-owned state, provider tools/results, persisted agent reuse through the same store, proof-file continuity, activity rendering, hook cleanup, and graceful stop all behaved as intended. The earlier failed fixture and state remain preserved as historical diagnosis evidence.
