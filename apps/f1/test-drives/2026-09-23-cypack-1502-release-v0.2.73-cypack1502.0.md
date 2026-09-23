# CYPACK-1502 local prerelease candidate F1 validation

Date: September 23, 2026. Candidate `0.2.73-cypack1502.0` from feature source
`89337bab1c08c616ef58f55ef82bc2f53c52892a`. Local preparation only: no supported
feature publishing workflow exists. No registry upload or release dispatch.

The F1 protocol ran against the built candidate with a fresh disposable home and
Git repository. The EdgeWorker and HTTP RPC were real; tracker, model runner and
GitHub credentials were deterministic offline fixtures. No live provider or GitHub
authentication was exercised. No shared-fallback or default-pin claim.

- Health/status succeeded; two users and issues DEF-1/DEF-2 created.
- Sessions session-1/session-2 created fresh worktrees and completed.
- Actual runner configurations selected distinct personal shared-store user refs.
- Both cross-user follow-ups visibly refused with runner starts unchanged at 2.
- Thought/response activity types and timestamps were coherent; disjoint 2-item
  pagination windows validated. No actual tool actions were synthesized.
- Both sessions stopped; awaited worker.stop() closed the ephemeral server.

Fresh checks: frozen strict-peer install, build, typecheck, all 2134 tests
passed (2 skipped), audit zero vulnerabilities, lint passed with 12
existing warnings. Full package packing/isolated-install results are recorded in
the parent feature's prerelease preparation report after this candidate commit.

The original historical live Claude draft PR17/18 and refusals remain separate
evidence. Review enforcement, Cursor/Codex live gates, hosted UI-to-runtime and
live shared-fallback/default-pin semantics remain limitations.
