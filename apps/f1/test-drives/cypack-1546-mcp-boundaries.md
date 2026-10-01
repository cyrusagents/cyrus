# CYPACK-1546: pre-native authority boundary costs

Executable Runtime `75438a10deb245e172bf07b7435ad321d9b7fa7a` stays unchanged.
This change adds request-local measurements to the existing native joined driver;
it does not change a production check, capability, lease or transport contract.

## Observed live startup

The coordinator's numeric-only `2026-10-01-combined-live-numeric-timing-072158.json`
records installed3978 / Hosted70ea occurrence ae168fef, completed in90.113s.
No new live request or checkpoint inspection was performed by Runtime.

| Stage | Observed duration |
| --- | ---: |
| Queue wait | 0.030ms |
| Ledger claim | 3.958ms |
| Admission | 2876.368ms |
| One MCP initialization | 3901.791ms |
| Five pre-native catalogs | 11952.746ms |
| Container initialization | 213.101ms |
| Native thread / turn start | 24.800 / 2.564ms |
| Dispatch to first native event | 22225.773ms |

The non-overlapping initialization/catalog intervals account for15.855s, about71%
of the22.226s pre-native delay. The runtime also retrieves fresh native context,
persists its checkpoint and delivers session/progress receipts. Progress overlaps
one catalog: these rows must not all be added. The24 retained catalog spans total
50.406s across the whole90.113s run;30 later spans were dropped. This observation
does not attribute historical44s turns, nor isolate network from provider/DB costs.

The client connects once. `tools/list` repeats because `fresh()` deliberately uses
it to revalidate the admitted session. Five-second polls share only a currently
pending check; completed permission results are not cached. Before native startup,
the five catalogs correspond to initial authority, progress, loop/context entry,
post-context and native model entry. Existing754 coalescing does not move fresh
context work or the configured factory's first open across those barriers.

## Actual Hosted handler / installed native proof

Frozen Hosted `198b3b48ecafeeaa89328865678eabdbffa76b58`, installed754 above,
same immutable native image35ffa8e695666695f047cf527138b9b27f2e1c29d44673f9eb705a0e4010be4f.
COMBINED and TOOL_REJECTION enabled. PASS88.449s:26 model requests,13 result
transmissions,121 activity deliveries. Original memory/work, current-source
withdrawal, delayed read references/renewal, ordinary rejected-write repair,
lost-write/result ACK and immutable recovery assertions remain intact.

| MCP phase | Requests | Preflight checks | Full authorize calls |
| --- | ---: | ---: | ---: |
| initialize | 13 | 13 | 13 |
| notifications/initialized | 13 | 13 | 13 |
| optional GET | 13 | 0 | 13 |
| tools/list | 251 | 251 | 250 |
| tools/call | 28 | 28 | 28 |

All13 optional GETs return405. They are not revoked connections. One catalog is
denied at preflight, before full authorization. GET runs concurrently after the
initialized notification; request-local AsyncLocalStorage avoids assigning its
work to a concurrent catalog. Fixed phase aggregates contain only finite numeric
counts/durations, no credentials, resource IDs, payloads or raw headers. Aggregate
authorization counts independently match the original fixture counters.

This is real SDK/handler/SQL/native execution with synthetic provider checks and
model responses. Millisecond SQL fixture timings are not live provider timings.
It proves protocol work/counts and retained boundaries, not a speed improvement.

## Concrete next correction and ownership

Hosted198b `authorizeMcp` explicitly calls `resolveWorkspaceCredential` in its
Linear branch and discards the token. For a customer read-set,
`assertLinearIssueAssociation` always reads the customer via `providerRequest`,
which resolves the credential again: workspace account, token-specific permission
receipt and fresh protected Linear permission probe, then the customer read.
This duplicates the complete permission path serially inside each catalog.

Runtime sent Hosted the exact bounded correction in threaded comment0e109cb8:
omit the earlier discarded resolve only for customer read-sets, retain the
downstream fresh permission/association checks and post-provider SQL validation.
Explicit issue bindings need their standalone check when no Customer association
exists. No cross-request credential/permission cache is needed. Hosted owns the
implementation and provider/account/revocation regressions; Runtime does not edit
its worktree. Live savings remain unmeasured until that exact fix is reviewed.

Protocol-only requests also currently perform full provider checks, including the
unsupported GET. A narrower handshake path is only a proposal (a0867191), not an
accepted contract or shipped runtime optimization. No new probe is relied upon.
Catalog construction itself is not established as a dominant cost. Current
provider, tool, renewal, receipt, scheduling and engineering checks stay intact.

## Reproduction

```sh
CYRUS_TEST_DOCKER_PATH=/usr/local/bin/docker \
CYRUS_TEST_DOCKER_HOST=unix:///var/run/docker.sock \
CYRUS_F1_CODEX_IMAGE=sha256:35ffa8e695666695f047cf527138b9b27f2e1c29d44673f9eb705a0e4010be4f \
CYRUS_NATIVE_JOIN_COMBINED=1 CYRUS_NATIVE_JOIN_TOOL_REJECTION=1 \
node apps/f1/native-context-join/run.mjs HOSTED_CHECKOUT \
  198b3b48ecafeeaa89328865678eabdbffa76b58 INSTALLED_PREFIX \
  75438a10deb245e172bf07b7435ad321d9b7fa7a NEW_EVIDENCE_DIRECTORY
```

Author evidence: attachments/catalog-boundaries-198b-7543 under CYPACK-1546.
New instrumentation is test-only; existing754 bundle/hash and installation remain
unchanged. No live runtime/customer effects or responsiveness acceptance claimed.
