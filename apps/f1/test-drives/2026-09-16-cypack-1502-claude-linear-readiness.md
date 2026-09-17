# CYPACK-1502: fresh shared-store Claude / actual Linear acceptance

**Superseded:** [fresh actual Linear A/B proof](2026-09-17-cypack-1502-claude-linear-ab.md).
Endpoint/OAuth recovery is complete, both draft PR17/18 have verified identities,
and B-to-A refusal passed. The text below is the earlier
pre-recovery snapshot, preserved as historical evidence.

September 16, 2026. **BLOCKED before actual Linear session execution.**
Runtime checked: `6872dfc5690ea9c8d54165026991a0dac1ca3e41`; Node 22/24 CI green.
This report does not count the historical Claude PRs or newer Gemini F1 checks
as Claude-through-shared-store actual Linear acceptance.

## Completed preparation

Fresh disposable root: `/private/tmp/cypack1502-claude-linear-2ntwjiph` (0700).
All five staged test files were freshly copied from the shared directory into
private 0600 files. The built CLI's two `add-user` commands ran **without skipping
provider checks**: both Claude Haiku round trips succeeded, and GitHub authenticated
the expected distinct actors. The resulting mappings use
`github.token: {store: "github-tokens"}`; the 0600 shared store contains two personal
entries. Claude credentials remain in separate protected files. All four policies,
including `followUpByOtherUser`, explicitly use `reject`.

| Existing test identity | Linear UUID | Live GitHub check | Live Claude provisioning check |
| --- | --- | --- | --- |
| A / Connor | `67a670bb-4d83-46ed-b98b-88bb2089d95d` | Connoropolous | passed |
| B / cyrusops1 | `917d99c8-c72d-4c22-9167-597f407faae9` | CyrusLimited | passed |

These are existing UUIDs from prior acceptance, supplied explicitly to provisioning;
fresh Linear actor delivery has **not** been observed. Both Claude tokens still
belong to the same underlying account; distinct subscription isolation is unproven.

`CyrusAgentTesting/test` was cloned through the shared-store personal Git helper
into the new home. Claude/Haiku routing, strict MCP configuration and a small file/
Bash tool allowance are prepared. The launcher will use separate OS HOME, Git/gh
and XDG configuration, with Slack/Zulip disabled. No new worker was started.
The existing repository setup hook requires root/apt-get; it was inspected but
not executed during preparation. No privileged installation or hook edit occurred.

## Actual Linear prerequisites

- The configured public endpoint,
  `https://flooring-freeze-daughters-releases.trycloudflare.com`, no longer resolves
  in both Python and curl checks. No replacement tunnel or app URL was created.
- Port 3742 is occupied by PID **73800**, an agentops Node process whose working
  directory is this feature checkout and whose open env-file path points to the
  **old disposable test home**. The process was not stopped or reconfigured.
- That old home's `config.json` and `.env` are no longer present on disk. Its saved
  test-workspace OAuth grant therefore cannot be reused from the expected files.
  The staged app client/signing secrets are present; OAuth reauthorization and
  their current validity have not been tested.

The operator must coordinate retirement of the old test listener and restore or
confirm the agreed test endpoint, then authorize **Cyrus CYPACK-1502 Test** in
**CyrusAgentTesting** for the new isolated home. Any changed tunnel hostname must
be coordinated with the app callback `/callback` and webhook `/linear-webhook`;
no app URLs should be replaced blindly. Internal Cyrus authentication is excluded.

A local OAuth resume wrapper is prepared at
`/private/tmp/cypack1502-claude-oauth-resume.py`. It refuses an occupied port and
prints only fixed status phrases, discarding the CLI's raw output so token prefixes
are not recorded. It has not been run. It targets the new home and verifies that
workspace `c3bbd343-69dd-4899-a201-976015c9c68d` receives an access token.

After endpoint/OAuth readiness, each human must trigger their own fresh test issue
in that workspace. Prepared prompt, substituting A or B:

> [agent=claude] [model=haiku] [repo=cypack1502-claude-shared-test]
> Shared-store credential acceptance A/B, run 2026-09-16. Confirm the actual result
> of `gh api user --jq .login`, `git var GIT_AUTHOR_IDENT` and
> `git var GIT_COMMITTER_IDENT`. Never print secrets or environment variables.
> Add one unique text file under `credential-evidence/`, commit and push this
> issue's branch, then create a **draft** PR against main. Report the PR URL and
> head commit SHA. Do not merge, approve reviews, change rules, deploy, install
> system packages or contact customers.

Follow the F1 verification sequence on the real delivery path: health; Todo issue
creation; actual human delegation/mention; signed webhook/session observation;
worktree, Claude/tool and activity evidence; cross-user refusal; and cleanup.
Record both issue UUIDs/identifiers, agent-session IDs, actual creator UUIDs,
Claude runner IDs, draft PR URLs/head SHAs/openers, and independent GitHub commit
**author and committer** metadata. Test B→A and A→B follow-ups under reject.
Any mock-tracker regression remains separately labeled.

**Fresh actual Linear issues: none. Sessions: none. Draft PRs: none.**
Those proof fields remain open, rather than substituting historical PR11/12.

## Read-only review-enforcement inspection

Both current PATs successfully read the repository and its `main` branch:
`protected: false`. Detailed branch protection returned HTTP 403 (PAT access);
effective rules/rulesets returned HTTP 403 with an upgrade/public-repository
availability message. The currently signed-in browser independently reloaded:

- [Rulesets](https://github.com/CyrusAgentTesting/test/settings/rules): no rulesets;
  private-repository enforcement requires GitHub Team.
- [Branches](https://github.com/CyrusAgentTesting/test/settings/branches): no classic
  branch protections configured.

Both historical draft PR11/12 review lists were empty. **Required human review /
no-bypass, self-approval refusal and another human's review are not proven.**
No review submission, rule, visibility, billing or bypass change was attempted.

Required prerequisite: the repository owner supplies and confirms an enforceable
main-branch required-human-review rule, including no bypass for the two test users,
and permits inspection of the effective settings. The owner must decide how to
provide that capability; this task did not change the plan or repository visibility.
Then, in a separately authorized human review exercise, each PR author verifies
self-approval refusal and the other human submits a normal review; record the
review IDs/states and required-review status without merging or bypass. Drafts
remain drafts under the current authorization.

The CLI provisioning evidence and API summaries are protected in the disposable
root. Four initial evidence files scanned clean for current supplied credential
values/prefixes. Current credentials are deliberately retained there for the pending
run; they were not copied into this report. The internal Cyrus home was untouched.
Codex/Cursor live prerequisites remain separate from this Claude-only blocked status.
