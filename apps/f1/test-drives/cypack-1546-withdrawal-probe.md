# CYPACK-1546: in-process withdrawal probe

Date: 2026-09-30. Applicable F1 behavior: optional test instrumentation holds an
admitted SDK connection while normal runtime recovery remains authoritative.

`node apps/f1/withdrawal-probe-drive.mjs` passes through actual registered instruction
and wake routes, production runtime/SQLite and real SDK JSON transport. Controlled
Hosted pause revokes the captured token. Original client's signal is deliberately
aborted; queued renewal cannot run during the barrier. Both post-pause probes still
reach the HTTP handler and return401 before token/lease expiry. After controlled
resume, the old credential again gets401. The same original occurrence retries with
fence2; new-session old-reference probe reaches the server and receives HTTP200/MCP
InvalidRequest(-32600). A current list/read then succeeds; exactly two synthetic
provider reads and one result, no provider write or ledger edit.

Ten focused tests pass: explicit opt-in, fixed target/role/revision, forged commands,
short expiry, barrier timeout, cancel, private filesystem/socket controls, wrong
origin/source rejection and refusal to delete an existing socket. Evidence omits
credentials/session IDs/references/provider bodies. See the committed JSON summary.

Initial fixture setup timed out due to protocol metadata validation and nested
synthetic tool-result parsing; both were corrected without changing runtime source.
The final drive passes. This does not establish live Hosted SQL/preview withdrawal,
UI restoration or real model behavior. The verifier owns those actions. The harness
uses existing runtime134a8a48 packages; it adds no runtime API or production import.

Launch/control/cleanup and remaining limitations: `apps/f1/withdrawal-probe.md`.
