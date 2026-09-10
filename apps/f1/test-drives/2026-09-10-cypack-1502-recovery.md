# CYPACK-1502 recovery regression drive

Date: 2026-09-10, 18:54–18:59 UTC. Runtime: local `cypack-1502` with recovery fixes.
Goal: verify isolated selection and fail-closed refusal paths after the review.

## Setup and commands

Fresh local Git fixture: `/tmp/cypack1502-recovery-f9kq9bba/repo`.
F1 home: `/tmp/cyrus-f1-1789066464878`. Server port: 3617.
Two mapped users (`user-ada`, `user-bob`) had distinct, explicitly invalid
placeholder OAuth/PAT files with mode 0600; `user-zoe` was unmapped.
Policy: `followUpByOtherUser=reject`. No real account credentials were provisioned.

```bash
CYRUS_PORT=3617 \
CYRUS_REPO_PATH=/tmp/cypack1502-recovery-f9kq9bba/repo \
CYRUS_F1_CONFIG_OVERRIDES=/tmp/cypack1502-recovery-f9kq9bba/overrides.json \
bun run apps/f1/server.ts
export CYRUS_PORT=3617
./apps/f1/f1 ping
./apps/f1/f1 create-user --name Ada --id user-ada
./apps/f1/f1 create-user --name Bob --id user-bob
./apps/f1/f1 create-user --name Zoe --id user-zoe
# Create separate issues with --labels primary, then:
./apps/f1/f1 start-session --issue-id issue-1 --as-user user-ada
./apps/f1/f1 start-session --issue-id issue-2 --as-user user-bob
./apps/f1/f1 start-session --issue-id issue-3 --as-user user-zoe
./apps/f1/f1 prompt-session --session-id session-1 --as-user user-bob \
  --message 'Bob follow-up should be rejected'
./apps/f1/f1 view-session --session-id session-1 --limit 2 --offset 5
```

## Observed results

| Case | Observed outcome |
| --- | --- |
| Concurrent Ada/Bob | Started at 18:56:16.412 and .485 UTC (73 ms apart); separate DEF-1/DEF-2 worktrees. Each runner logged its own mapped user and different credential fingerprints. |
| Invalid Claude credentials | Both reached Anthropic and returned `401 OAuth access token is invalid` at 18:56:20. No successful provider execution is claimed. |
| Unmapped Zoe | Session-3 had a response naming Zoe and `cyrus add-user`; no DEF-3 worktree. The issue title mentioned a child, but no parent was set in F1; the actual child case is tested at EdgeWorker level below. |
| Bob follows Ada | Session-1 received a response refusing Bob under `followUpByOtherUser=reject`; no resumed runner. |
| Empty Ada file | Session-5 refused with a reference-only error before worktree creation; no DEF-5 worktree. |
| Empty-file race | Session-4 passed preflight before the file was emptied, created DEF-4, then refused at runner-build re-resolution. This confirms the second reference read catches rotation/removal between those steps. |
| OpenCode | After restoring Ada's placeholder file, session-6 on `[agent=opencode]` returned `The opencode runner does not support per-user credentials`; no OpenCode provider run. |
| Activity rendering | Thought, error, prompt and refusal response activities had timestamps. `--limit 2 --offset 5` returned the expected two of eight session-1 activities. |
| Cleanup | All six F1 sessions accepted stop commands; the test server was stopped. |

The server logged the expected authentication errors through its error handlers
(including an `Unhandled claude error` log label). It continued serving requests.
This is a **negative-path acceptance drive**, not a successful model-work drive.
No PR was created, no push actor was observed, and Linear was the in-memory tracker.

## Regression and suite evidence

- Core credential tests: 22 passed. Env references, both PAT variables, provider
  switches, human/unknown child refusal and pin/reject policies.
- EdgeWorker/service/builder regressions: 30 passed across three files. Actual
  `configChanged` listener after removal of the last mapping; resume and streaming
  follow-up refuse. Current authors govern legacy/recovered sessions. Unknown
  authors cannot inherit known parent pins. Host chat env filtering and skipping
  host prewarming are covered.
- ClaudeRunner: 38 passed in its main test file, including the SDK env overlay and
  disabled file settings sources when credential env filtering applies.
- Full package suite: 1,817 passed, 2 skipped. EdgeWorker: 864 passed, 1 skipped.
- CLI suite: 118 passed. F1 has no unit test files; its validation is the drive above.
- `pnpm build`, `pnpm typecheck`, `pnpm lint`: passed (12 existing lint warnings).
- Hosted emitted-key guard: 6 passed. Hosted changes in this recovery are docs only.

Two real Claude accounts, two distinct GitHub PR authors, authenticated push actors,
self-approval rejection and real Linear attribution remain unverified. Use the
[secure two-real-user checklist](../../../docs/PROMPTER_CREDENTIAL_VERIFICATION.md)
to complete that evidence. Environment separation is not an OS security boundary.
