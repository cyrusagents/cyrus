# Test Drive: final SDK 0.3.291 runtime acceptance (CYPACK-1565)

**Date:** 2026-10-06, 16:10 UTC  
**Result:** **BLOCKED — authentication failed; runtime acceptance remains open.**  
**Tested pushed head:** `217f2a87e18c441d946ea442c40948bf7ed53801` ([#1529](https://github.com/cyrusagents/cyrus/pull/1529)).  
**Runner source blob:** `f8caaee44cce9546f8524bf084eae8c7825a8a33`.  
**Evidence:** [selected SDK events and complete F1 activity payloads](2026-10-06-cypack-1565-runtime-evidence.json).

This is a fresh live attempt on the reviewed 0.3.291 head, not the inherited
0.3.289 reports or the dummy-credential initialization probe. This follow-up
changes evidence/documentation only. A successful run on the final pushed head
is still required after reconnecting the identity below.

## Environment and identity

- macOS arm64, OS user `agentops`, home `/Users/agentops`.
- Isolated checkout: `/private/tmp/cypack-1565-runtime-acceptance`. The supplied
  workspace was actually on `cyhost-1082` with unrelated edits; it was left intact.
- F1 host: Bun 1.3.14. Build/package manager: Node 22.17.1 and pnpm 10.33.1.
- Installed Agent SDK **0.3.291**, Anthropic API SDK **0.131.0**; actual SDK init
  reports bundled Claude Code **2.1.291**, model `claude-sonnet-5-5`, and
  **`permissionMode=default`**.
- Both installed CLI 2.1.280 and bundled CLI 2.1.291 `auth status` report the
  existing `connor@ceedar.io` Max subscription, `authMethod=claude.ai`,
  `apiProvider=firstParty`, config directory `/Users/agentops/.claude`.
  This is the existing local test identity, not a replacement API key or account.
- `CLAUDE_CONFIG_DIR`, `ANTHROPIC_API_KEY`, and `CLAUDE_CODE_OAUTH_TOKEN` were
  unset. No credential values were read, copied, or included in the evidence.
- Fresh rate-limiter fixture: `/private/tmp/cypack-1565-f1-repo`, commit
  `60b5ddb`, with committed `.claude/settings.local.json` containing
  `permissions.defaultMode=acceptEdits` and `env.DISABLE_TELEMETRY=1`.
- Port 3600 was occupied; the drive used 3601. Remote transcript mirroring was
  disabled with the supported `CYRUS_DISABLE_REMOTE_SESSION_STORE=1` switch.

## Actual results

| Check | Observed result |
| --- | --- |
| Health / status | Healthy / ready |
| Issue / routing | `issue-1` / `DEF-1`, `primary` label selected F1 Test Repository |
| F1 session | `session-1`, started at `2026-10-06T16:10:31.104Z` |
| Claude session | `767824dd-5e47-4fa2-9dd0-bf366984b0d8` |
| Worktree | `/private/tmp/cyrus-f1-1791303030107/worktrees/DEF-1` |
| Permission mode | `default` in actual `system/init`, despite fixture `acceptEdits` |
| Read README.md | **Not executed**; zero tool-use and tool-result events |
| Bash pwd | **Not executed**; zero tool-use and tool-result events |
| Terminal SDK result | `is_error=true`, `api_error_status=401`, `terminal_reason=api_error`, zero input/output tokens |
| Completed final response | **Absent**; no `SDK_RUNTIME_OK` model response |
| Activity rendering | Routing, model choice, and authentication error are timestamped and readable |
| Pagination / search | Offset 1 / limit 2 returned routing + model; `Routing` search returned one activity |
| Cleanup | `stop-session` succeeded; SIGINT shut down the server gracefully |

The terminal error was:

```text
Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue.
```

The SDK result's `subtype` is `success` **but `is_error` is true**. Likewise,
F1's `complete` status and final "I've stopped working" response were generated
by `stop-session`. Neither is evidence of a successful model completion.

## Supported refresh / reconnect path

The stored claude.ai login uses Claude Code's automatic OAuth refresh. The
live 401 shows that it did not provide a usable token for this run; a cached
`auth status` result of `loggedIn=true` does not validate inference. Anthropic's
[expired OAuth recovery guidance](https://code.claude.com/docs/en/errors#oauth-token-revoked-or-expired)
requires signing in again in the **same environment** when an SDK saved login
fails this way. The supported command to initiate that browser flow is
[`claude auth login`](https://code.claude.com/docs/en/cli-reference).

**Required human action:** on this same Mac, in a regular terminal logged in as
`agentops` with access to its login Keychain, run:

```sh
env -u CLAUDE_CONFIG_DIR -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN \
  -u CLAUDE_CODE_OAUTH_TOKEN \
  /Users/agentops/.local/bin/claude auth login --claudeai --email connor@ceedar.io
env -u CLAUDE_CONFIG_DIR -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN \
  -u CLAUDE_CODE_OAUTH_TOKEN /Users/agentops/.local/bin/claude auth status
```

Complete browser authorization as `connor@ceedar.io`; verify `authMethod=claude.ai`
and `configDirectory=/Users/agentops/.claude`. The email flag only pre-fills the
login page, so verify the returned account. An interactive `claude` followed by
`/login` in that same environment is the equivalent recovery path. No token
should be pasted into an issue, PR, or this conversation.

This agent's allowed write roots do not include `/Users/agentops/.claude` or
the login Keychain, and browser account authorization requires the identity
owner. Reconnect was requested during this review; it has not been completed.
`setup-token` is an alternative for deliberately configured token-based
automation, not a repair of this stored-login identity, and was not substituted.

After reconnecting, restart F1 from the final pushed head and repeat:

```sh
cd /private/tmp/cypack-1565-runtime-acceptance
git fetch origin cypack-1565
git merge --ff-only origin/cypack-1565
git rev-parse HEAD
# Reinstall/build if the runtime changed; create a fresh fixture for the new drive.
apps/f1/f1 init-test-repo --path /private/tmp/cypack-1565-f1-reconnected
# Recreate/commit the settings.local.json fixture described above.
CYRUS_DISABLE_REMOTE_SESSION_STORE=1 CYRUS_LOG_LEVEL=INFO CYRUS_PORT=3601 \
  CYRUS_REPO_PATH=/private/tmp/cypack-1565-f1-reconnected DISABLE_TELEMETRY=1 \
  bun run apps/f1/server.ts
# In a second terminal in the same checkout:
CYRUS_PORT=3601 apps/f1/f1 ping
CYRUS_PORT=3601 apps/f1/f1 status
CYRUS_PORT=3601 apps/f1/f1 create-issue \
  --title 'Verify SDK permission policy with real tools' --labels primary \
  --description 'Read README.md using Read, run pwd using Bash, then report the repository purpose and include SDK_RUNTIME_OK. Do not edit files, commit, push, or contact external integrations. [agent=claude] [model=sonnet]'
CYRUS_PORT=3601 apps/f1/f1 start-session --issue-id issue-1
CYRUS_PORT=3601 apps/f1/f1 view-session --session-id session-1
# Stop on completion/error, or after 120 seconds without a terminal result:
CYRUS_PORT=3601 apps/f1/f1 stop-session --session-id session-1
# Ctrl-C the server in its terminal.
```

Capture actual Read content, Bash stdout, an error-free SDK terminal result,
and the model's completed `SDK_RUNTIME_OK` response before closing the gate.

## Coordinated package identities

[cyrus-hosted#1129](https://github.com/cyrusagents/cyrus-hosted/pull/1129) remains
at `b2b6101e854bc6a7c9571b7daba9b411c0efb9e6` at evidence capture. Its
`apps/app/package.json` pins `cyrus-core@0.2.74-test.6` and `@anthropic-ai/sdk`
`^0.131.0`. Core does **not** ship ClaudeRunner; its hosted pin alone cannot
prove the runner permission fix is deployed.

| Published artifact | Immutable npm integrity |
| --- | --- |
| `cyrus-core@0.2.74-test.6` | `sha512-zyZA4TOZ4lmA+X1IxB49YrCpFB3Bbh7B+ZfQ/xkbjyGUobZBqRzYq8zRsFMzjeyZsGlGSCUvc2nAoz3kV1lSWQ==` |
| `cyrus-claude-runner@0.2.74-test.1` | `sha512-B56NuQ+oxySBWv8csVq5gTPbgoHVtvoAEckVa/0c3zaAji8jPL7IYEugEWMDqIWNdaxEN8fhmqPQOFXaT76xDg==` |

Both tarballs were downloaded and their SHA-512 integrity verified. Both pin
Agent SDK 0.3.291. The runner tarball's `dist/ClaudeRunner.js` is byte-identical
to this checkout's build (SHA-256
`b417ab7cd033477f392974d9e17c207528174f1f19f6d43eec4b64db397a23a3`).
Its published dependency on `cyrus-core` remains **0.2.73**, distinct from the
hosted app's core **0.2.74-test.6**; this is not a claim that the tarball depends
on test.6. This F1 drive used workspace core/runner builds (manifests 0.2.73)
from the tested source, with the lockfile's 0.3.291 SDK. It did not exercise an
installed hosted deployment. npm `test` tags point to the two artifacts above;
both `latest` tags remain 0.2.73. No package publication was needed for this
documentation-only follow-up.

The companion's separate request for paired base/head full-suite evidence is
also still open; this F1 report does not resolve that hosted acceptance item.

## Repository verification

- Frozen dependency installation: passed; lockfile unchanged.
- `pnpm build`: passed.
- `pnpm test:packages:run`: passed.
- `pnpm typecheck`: passed.
- `pnpm lint`: passed with 14 existing warnings.

These checks do not substitute for authenticated Read/Bash execution and a
completed model response. Neither PR is ready to claim that acceptance gate.
