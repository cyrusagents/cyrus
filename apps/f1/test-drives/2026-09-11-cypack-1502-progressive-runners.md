# CYPACK-1502: progressive personal credentials across runners

Date: September 11, 2026 (Pacific). Runtime: PR #1472, progressive-runner follow-through.

## Behavior under test

Personal GitHub identity applies to Claude, Codex, Cursor, Gemini and OpenCode.
Personal Claude authentication is optional and consumed only by Claude. A
GitHub-only mapping retains the runner's existing model authentication. A
configured unreadable Claude credential fails a Claude start but does not block
another runner. Effective resume runner selection, rather than a changed issue
label, determines whether Claude authentication is resolved.

Existing reject/pin ownership policy still applies to follow-up prompts and live
issue title/description/attachment updates. Existing `host` policy values remain
compatible aliases for `shared`.

Validation: full monorepo suite **1,973 passed, 2 skipped**; build and typecheck
passed; lint passed with 12 pre-existing warnings. The public MDX guide compiles.

## Automated evidence

- Core resolution covers GitHub-only mappings, unreadable optional Claude
  references, and personal Claude override/competing-credential removal.
- Builder tests cover all five runners; EdgeWorker tests verify each persisted
  runner still determines model-auth resolution after labels change.
- Gemini spawn capture verifies personal GitHub identity, source-env removal,
  retained Gemini model auth, and unchanged parent environment.
- OpenCode runs two actual subprocesses with an offline CLI fixture; each captures
  its own GitHub/commit identity, unchanged model auth and no other user's source
  variable. This does not exercise OpenCode provider authentication.
- Codex config and app-server pool tests verify distinct processes for distinct
  GitHub environments, unchanged model auth, and a shell environment policy that
  retains the filtered environment. No token is placed in the policy or argv.
- Cursor runs two actual workers concurrently, with an offline SDK fixture that
  launches shell subprocesses. Captured tool environments contain the respective
  GitHub identity, unchanged Cursor auth and no other user's source variable.
  Resume, messages/completion, cancellation, errors and SDK disposal are checked.
- The built CLI completes add/list/check/remove with both full and GitHub-only
  mappings; absent optional Claude auth is not displayed as a broken mapping.

Cursor's installed SDK 1.0.19 `LocalAgentOptions` has no per-agent environment
option, so the runner uses an independent Node worker environment. This is not an
OS security boundary. Codex's shell policy is documented in the
[official configuration reference](https://developers.openai.com/codex/config-reference/).

## F1 drive

Fresh disposable repository and references-only GitHub mappings for `ada` and
`bob`; placeholder tokens only. F1 listened on port 3619 with `defaultRunner:
"cursor"`, strict reject policy and `CYRUS_CURSOR_MOCK=1`. The process had a clean
environment and no real model credentials. No existing Cyrus home was changed.

| Step | Observed result |
| --- | --- |
| Health, create users and issues | Healthy; Ada/Bob and DEF-1/DEF-2 created |
| Start as Ada/Bob, select repository | Correct owner thoughts, separate worktrees, cursor/composer-2 selected |
| Initial executions | Both completed with `Cursor mock session completed`; runner starts logged 1 ms apart |
| Bob prompts Ada's session | Visible rejection; Ada's total runner starts stayed at one |
| Bob prompts his own session | Second successful response; Bob's runner starts increased to two |
| Activity rendering | Thought/response types, content and timestamps present; CLI table and pagination readable |
| Cleanup | Both sessions stopped; disposable server stopped separately |

This F1 drive proves webhook/ownership/runner/response wiring with mock execution.
It does **not** prove Cursor model access, a real provider tool call, a GitHub
push, or PR authorship. The subprocess tests above use offline provider fixtures.

## Provider proof and prerequisites

[Earlier real-provider evidence](2026-09-11-cypack-1502-provider-acceptance.md)
remains limited to Claude: two real Linear users completed runs and created
unmerged draft PRs under Connoropolous and CyrusLimited. The Claude tokens are
distinct but belong to one underlying account. Separate subscription isolation
is not proven. The repository has no enforced required-review/no-bypass rule,
so that acceptance remains incomplete.

To accept Codex, Cursor, Gemini or OpenCode with a real provider, configure that
runner's supported model authentication on the isolated instance, then repeat
both users' actual HTTPS push, draft-PR author and commit identity checks using
the [verification checklist](../../../docs/PROMPTER_CREDENTIAL_VERIFICATION.md).
Do not interpret GitHub account permission metadata as PAT write-scope proof.
Have the repository owner enable/confirm required reviews and no bypass before
review acceptance; never merge or bypass. OpenCode must use its own supported
authentication, not a translated personal Claude OAuth token.
