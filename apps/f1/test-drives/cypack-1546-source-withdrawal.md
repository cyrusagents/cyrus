# CYPACK-1546: source withdrawal revision split

2026-09-30. Functional F1 harness change, pinned to unchanged installed runtime
134a8a48. Historical6227 Pause evidence is preserved; no live Pause rerun.

`node apps/f1/withdrawal-probe-drive.mjs --source-withdrawal` PASS: real registered
HTTP routes, SQLite, runtime and MCP SDK with controlled mapping/Hosted/model/provider.
Remove revokes old credentials and delivers revision2; old revision1 occurrence
cancels after exactly one attempt. Old unexpired session tools/list and get_issue
receive actualHTTP401 despite local abort; after reconnect old credential again401.
Authenticated stale retry returns409 both before and after reconnect. A DIFFERENT
revision3 occurrence starts at attempt/fence1; its new SDK session rejects the old
reference (HTTP200/MCP-32600), then fresh normal list/get succeeds. Exactly2 synthetic
provider reads and1 new result. No old checkpoint rebind or ledger edit. Evidence
omits credentials, raw reference/session IDs and private provider content.

17 focused tests PASS, including source/Pause command separation, forged controls,
preloader mode rejection, distinct internal/external scope, expiry inconclusive and
private socket permissions. Source F1 additionally rejects old occurrence/old revision
and forged scope in arm-current. Existing Pause and revision-change F1 regressions PASS.
The first new fixture run used invalid registration state 'disabled' and returned409;
the fixture was corrected to the existing enabled source-free registration semantics.
No production API or runtime source changed to accommodate it.

Recipe: apps/f1/withdrawal-probe.md source-withdrawal section. The old credential
reconnect check must finish BEFORE original expiry; a late picker operation is
inconclusive, never justification to extend credentials or repeat removal. The new
occurrence may run later under current authority. Old cancellation/retry and live UI
persistence require independent verifier evidence; harness complete alone is not SQL
proof. Hosted owns recipe correction and actual migration43/UI/provider coverage.
No author live install/restart, source removal/reconnect, model or provider call.
