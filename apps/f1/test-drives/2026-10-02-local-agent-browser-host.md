# Local macOS browser investigation: launcher prototype and native rules

Date: 2026-10-02

The launcher described below is a superseded prototype. A later documentation-only revision used
Codex's existing command-rule mechanism and removed the launcher implementation.
The current generic sandbox-mode revision is validated separately in
[the sandbox-mode drive](2026-10-02-codex-sandbox-mode.md).
Historical Linear/F1 evidence is retained here; the native-rule checks at the end
are separate direct Codex smoke tests.
Base: `f5f18a1`, with the local browser-root changes and the changes from
`fix/configurable-sandbox-writable-directories` (`ed5f6ce`) consolidated into
the primary checkout, plus `scripts/local-agent-browser.mjs`.

## Reproduction and root cause

Real Linear issue [ATT-1116](https://linear.app/attraccess/issue/ATT-1116)
delegated a short, read-only test to the local Cyrus Codex runner. Both installed
Chrome and Brave exited before exposing DevTools; open and close returned 1.
The commands used fresh named sessions and `https://example.com`.

A direct `codex sandbox` probe, with browser state writable and network enabled,
reproduced the same error. `--log-denials` recorded denied Mach lookups including
LaunchServices and WindowServer. The same installed browsers successfully opened
the page when launched on the host. Browser state permission alone is therefore
insufficient, and switching from Chrome to Brave does not resolve the restriction.

An initial operational retest still selected `/opt/homebrew/bin/agent-browser`:
the login shell reconstructed PATH and bypassed the wrapper on the service PATH.
Installing the same wrapper in `~/.local/bin` corrected the actual agent-shell
lookup. A further check found that host daemon cwd must match the caller's
worktree for relative screenshot paths to work without copying files.

## Fix

- A user LaunchAgent bootstraps named browser daemons on the host. Normal CLI
  commands remain in the agent environment; Codex's command sandbox stays enabled.
- Bootstrap accepts a generated session id, an allow-listed Chrome/Brave binary,
  the caller's existing absolute directory, and a debug boolean. It cannot execute
  arbitrary shell commands or arbitrary binaries.
- Logical sessions are isolated by working directory. Browser selection is
  retained, so Brave survives subsequent commands in a Chrome-default environment.
- The daemon starts in the caller's directory, preserving native relative output
  paths. The broker uses an owner-only Unix socket in `~/.agent-browser`.
- The local Cyrus service PATH and its Nix source configuration include the wrapper.

## Final real Linear test

ATT-1116's final response confirms `command -v agent-browser` selected
`~/.local/bin/agent-browser`.

| Browser | Open | Get title | Screenshot | Verify PNG | Close |
| --- | ---: | ---: | ---: | ---: | ---: |
| Chrome | 0 | 0 | 0 | 0 | 0 |
| Brave | 0 | 0 | 0 | 0 | 0 |

Both titles were `Example Domain`. PNGs were saved directly into the issue
worktree and visually inspected: Chrome 1280×633; Brave 1280×639. Named sessions
were closed. Evidence was copied to `~/.cyrus/browser-host/evidence/ATT-1116/`
before completing the diagnostic issue.

## F1 validation

Fresh repository: `/tmp/cyrus-browser-host-f1-20261002`.
Server: port 3600, `CYRUS_DEFAULT_RUNNER=codex`, `CODEX_MODEL=gpt-6.1-sol`,
`CYRUS_BROWSER_USE_ENABLED=1`.

Commands: `ping`, `status`, `create-issue`, `start-session`, `prompt-session`,
`view-session`, and `stop-session`. The test created `DEF-1` / `session-1`, selected
the test repository, and exercised browser commands through an actual sandboxed
Codex session. Initial attempts reproduced the PATH problem; final named sessions
`f1-cwd-chrome-final` and `f1-cwd-brave-final` both passed open/title/screenshot/close
with exit 0. Both PNGs existed directly in the F1 worktree, without copying.

The server logged successful final-response posting for the final continuation
(`activity-97`); the Codex transcript contains the full passing result. F1
`view-session` exposed readable timestamped tool activities, but its visible
continuation history did not include the final iteration when searched by the
final session names. This renderer limitation is separate from browser execution;
the real Linear timeline exposed the complete final result.

The session stopped successfully and the F1 server was shut down. No project
implementation, PR, or external website mutation was performed by either agent.

## Other checks and limits

- Full `pnpm build` and `pnpm typecheck` passed after checkout consolidation.
- Existing runner/browser/config tests: 20 passed; core schema tests: 7 passed.
- Helper syntax and Biome checks passed; malformed bootstrap input was rejected.
- Sandboxed login-shell probes verified title, screenshot, close, reopen, browser
  retention, and relative screenshot output in the caller directory.
- `pnpm install` succeeded. `pnpm audit` reports one node-forge advisory,
  GHSA-86w9-cpqp-85rv, with no patched version listed. Consolidated dependency
  changes are outside this draft; this is not a clean dependency-audit result.
- Custom profiles, cloud providers, and other daemon policy overrides were not
  validated. The companion is optional macOS local tooling, not a cloud-runtime
  dependency. Browser operations run with the local user's host access.

## Original prototype PR scope (superseded)

The original draft included the optional companion, setup documentation, and this
validation record. The companion has since been removed from the draft. The validation base above included the separate filesystem
permission implementation. Those runtime/configuration/dependency changes are
not included here; see [PR #1516](https://github.com/cyrusagents/cyrus/pull/1516)
for configurable writable directories. The upstream helper uses the project
LaunchAgent label `com.cyrusagents.browser-host` instead of the local prototype
label. It also rejects relative CLI paths and existing installation paths,
including dangling symlinks. These packaging checks do not alter the tested
browser bootstrap protocol.

## Original prototype packaging verification

On upstream base `8533e11`, `pnpm install --frozen-lockfile` succeeded without
lockfile changes. The updated source helper passed Node syntax and Biome checks.
An isolated temporary HOME and host process exercised the actual updated helper
through `codex sandbox`: Chrome and Brave both passed open/title/relative PNG
screenshot/close against a local data URL. Owner-only socket permissions and
malformed bootstrap rejection passed. Install attempts with a relative CLI path
or an existing dangling wrapper symlink were rejected without replacement.
The installed local LaunchAgent was left unchanged.

The packaging changes affect the label and pre-install checks only. The earlier
F1 and real Linear drives cover the unchanged bootstrap and session protocol;
this additional smoke check covers the source helper being submitted.

## Native command-rule alternative

The revised draft documents operator-managed Codex rules rather than maintaining
a client-specific launcher. A temporary user-layer rule allowed only the absolute
Homebrew CLI path followed by `--session` and the unique smoke-test session name.
`codex execpolicy check` reported the matching `allow` decision. An initial Brave
rule check did not match its new session name; that run was terminated before
browser commands and the rule was corrected before the checks below.

Fresh installed Codex CLI `0.159.2` (`codex exec`) sessions used `--sandbox workspace-write` and
`approval_policy="never"`, invoking the original CLI at
`/opt/homebrew/bin/agent-browser`. Chrome passed open/title/relative screenshot/close.
Brave also passed these operations after its executable was specified consistently
on every command. Both final titles were `Example Domain`, and the Brave URL
was `https://example.com/`. All final browser commands exited 0.

The environment defaulted to Chrome through `AGENT_BROWSER_EXECUTABLE_PATH`.
Specifying Brave only on `open` initially returned an empty title and
`about:blank` on subsequent commands. Repeating the Brave executable for the
entire session resolved that separate configuration issue.

An unrelated Python exclusive-create probe outside the workspace printed
`PermissionError: Operation not permitted`. It was not covered by the command
rule, confirming that the rest of the session remained sandboxed. Named test
sessions were closed and the temporary rule was removed in a cleanup handler.
No permanent operator permissions, installed wrappers, or Cyrus service settings
were changed. No new Linear/F1 run was performed for the documentation-only
revision, and their earlier prototype results are not native-rule validation.

That documentation-only revision contained documentation and historical investigation
evidence only. Native command rules remain experimental and subject to the
operator's existing/managed policy.
