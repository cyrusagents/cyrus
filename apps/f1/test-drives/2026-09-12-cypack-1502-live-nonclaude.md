# CYPACK-1502: live non-Claude acceptance and Cursor lifecycle

Date: September 11, 2026 Pacific / September 12 UTC. Runtime under test:
`163c594e`, PR #1472. This follow-through changes tests/evidence only.

## Authentication inventory and isolation

All four non-Claude CLIs were installed. The existing isolated test home had no
non-Claude auth files or model keys in its `.env`. The current authorized agent
process had OpenAI, Gemini and Cursor API keys. Each probe received only its
relevant provider key in a new, clean environment, with private HOME/XDG/Cyrus
paths under a separate mode-0700 test root. No internal Cyrus auth/home or live
worker was changed. No host login cache was copied. Codex API login used stdin
and created only the isolated `CODEX_HOME/auth.json`, mode 0600, using the
[documented API-key login](https://developers.openai.com/codex/auth/).

| Runner | Installed version / model | Live outcome | Missing prerequisite |
| --- | --- | --- | --- |
| Gemini | CLI 0.17.1 / gemini-2.5-flash | Model calls, both personal GitHub actors, pushes and draft PRs verified | None for these checks; review enforcement remains separate |
| OpenCode | CLI 1.17.7 / openai/gpt-5.5 | Model calls using OpenAI API auth, both personal GitHub actors, pushes and draft PRs verified | Initialize a fresh shared OpenCode state store sequentially before concurrent starts; see F1 limitation below |
| Codex | CLI 0.143.0 / gpt-5.5 | API login and model responses succeeded; shell tools could not start | Run the isolated probe as agentops from a normal terminal/environment that permits Codex's own workspace-write sandbox. The current outer Mac sandbox rejects `sandbox_apply` with `Operation not permitted`. Do not disable the runner sandbox. |
| Cursor | SDK 1.0.19 (installed CLI 2026.04.28-e984b46) / composer-2 requested | Actual SDK rejected the available key with `Invalid User API Key`; worker error completion verified | A valid Cursor user API key authorized for SDK model access, staged securely for the isolated child; an authenticated successful session is needed for live stop/resume proof |

The Gemini and OpenCode runs use shared model-provider authentication while
switching GitHub identity. They do not establish personal model billing. OpenCode
was not given a personal Claude OAuth token. Key presence was not treated as
proof of validity. Codex's first harness attempt used a reserved provider override;
that test setup was corrected before the successful API-authenticated run. Model
success results whose text reports blocked tools are not counted as tool success.

## Real GitHub write evidence

The actual runners fetched `CyrusAgentTesting/test`, created one text-file commit,
pushed over HTTPS without force, and invoked `gh pr create --draft`. Independent
GitHub REST reads checked PR author, head SHA, draft/open/unmerged state, commit
author and committer against the configured identity, and the exact changed file.

| Runner | GitHub actor | Draft PR | Head SHA |
| --- | --- | --- | --- |
| gemini | Connoropolous | [13](https://github.com/CyrusAgentTesting/test/pull/13) | `f06d8e7db95e93a4a776eef2585b852964d79b08` |
| gemini | CyrusLimited | [15](https://github.com/CyrusAgentTesting/test/pull/15) | `4f5b606d4f90a037f42efb8996ff2afbcd1a6583` |
| opencode | Connoropolous | [14](https://github.com/CyrusAgentTesting/test/pull/14) | `bed8f4c5a366791d706f379e7e3dda0ecdd385ae` |
| opencode | CyrusLimited | [16](https://github.com/CyrusAgentTesting/test/pull/16) | `57a58772b5876a98eb6b38e715e4b13a0ffc989f` |

Each user's row used their previously staged PAT and current Linear UUID mapping.
These were direct isolated runner calls, not new human-triggered Linear sessions.

Prior Claude [PR #11](https://github.com/CyrusAgentTesting/test/pull/11) and
[PR #12](https://github.com/CyrusAgentTesting/test/pull/12) were re-read and remain
unmerged drafts under Connoropolous and CyrusLimited. Their earlier real Linear
session evidence is preserved. Both Claude tokens belong to one underlying
account; separate subscription isolation is still unproven.

No PR was merged, approved or bypassed, and no rule was changed. Current PAT
requests for branch protection and rulesets returned HTTP 403, so they do not
establish current review settings. Earlier review acceptance was incomplete;
required-review/no-bypass proof still needs owner-confirmed enforced rules and a
human review exercise. Repository account permission metadata is not that proof.

## Live F1 flow (mock tracker, real providers)

F1 on isolated port 3621 used strict reject policy and the current references-only
user mapping. No provider mock flag or SDK fixture was enabled.

- Gemini sessions 5/6 completed real calls and shell actions, returning
  Connoropolous and CyrusLimited respectively. Owner thoughts, model selection,
  action results and final response activities were present. One final response
  said only “I have completed the request”; its tool result and thought contain
  the verified login.
- OpenCode's first concurrent sessions 7/8 failed with `database is locked` during
  fresh shared state startup. Both posted visible error activities, with no
  successful provider result. This is a real limitation, not a passing test.
- A sequential OpenCode session 9 succeeded. The subsequent concurrent sessions
  10/11 (started 41 ms apart) both completed with the correct respective GitHub
  logins. This supports concurrent use after state initialization, not reliable
  concurrent first-start initialization of a fresh OpenCode 1.17.7 store.
- An initial harness request used the wrong actor parameter and was rejected as
  unmapped `user-default`; using the documented `asUserId` field corrected the
  harness. No creator fallback or runner execution occurred for those requests.

F1's issue tracker is simulated. These live F1 results complement the actual
provider/GitHub writes above; they are not new real-Linear webhook acceptance.

## Cursor worker lifecycle

The actual invalid-key attempt emitted one error result, one completion callback,
and `isRunning=false`; it did not throw an unhandled worker error. It does not
prove successful model execution or real session resume.

The strengthened offline test uses real Node worker threads and shell subprocesses
with an SDK fixture. Two initial sessions start concurrently. A fresh runner then
resumes the actual session ID returned by its earlier start, and the fixture
checks that this ID exists in persisted state. The resumed shell retains the same
GitHub owner. An active run is canceled and becomes stopped; an SDK failure emits
exactly one completion and becomes stopped. SDK disposal is asserted for success,
resume, cancellation and failure. Parent auth remains unchanged. All **45 Cursor
tests pass**. This lifecycle success evidence is explicitly offline.

## Remaining actions

- Supply a valid Cursor SDK user API key through the protected staging channel,
  then repeat successful start, active stop, resume and both users' PR checks.
- Run the prepared `run-codex-acceptance.sh` from the private probe root in a normal
  agentops terminal. It uses the isolated auth cache and existing GitHub references,
  keeps workspace-write sandboxing enabled, and creates only disposable draft PRs.
- Have the repository owner confirm and enforce review/no-bypass rules before
  review acceptance. Do not merge or bypass.

Evidence JSON/logs were scanned for the actual staged/provider secret values;
none appeared in the inspected evidence files. Secrets/auth stores remain private.
