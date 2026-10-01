# CYPACK-1546: share pending checks at contained model entry

The live ae168 recall/work trace on installed3978 completed in90.113s, first native
turn22.226s, with24 retained catalog spans totalling50.406s and30 dropped spans.
It has one MCP initialization and a213ms container initialization. Repeated
reconnection/container startup is not the cause of those repeated catalogs.
The truncated record does not establish all callers or total critical-path time.

## Narrow change

The generic execution loop used to await its authority check, then immediately
invoke native next(), which awaited another authority check. Both calls now remain,
but an explicitly declared internal adapter contract allows native entry to start
while the loop check is pending. Native next() awaits the same in-flight request
before container work, returning a native tool reply, or releasing a captured
pending tool step. Each later call still goes through fresh(); no completed result
is reused, no TTL/cache is introduced, and no MCP/Hosted schema changes.

Only contained Codex opts in. The configured registration factory performs readiness
I/O and stays conservative: its first open keeps the original ordered check. Its
returned contained model declares the entry contract, so subsequent model steps
can join. Native context preparation, already-pending runtime operations, absent
or unknown declarations retain ordered barriers. Snapshot, broker, provider body,
tool invocation, post-tool, progress, renewal, receipt reconciliation and final
activity ACK barriers are unchanged. Every tools/call retains server authorization.
The local declaration cannot be set by an admitted definition or model arguments.

The recovered native tool early-return path now also awaits current authorization
and checks abort before releasing the saved tool step. A denied replay returns no
step and starts no container/model request.

## Controlled evidence

The existing two-tool native Slack fixture reads admitted history then its opaque
thread reference. Its25s model delay forces same-session renewal; no live Slack
transport is used. Add500ms per MCP request and40ms per other Hosted callback.
The profile wrapper uses an unmarked factory like the configured registration
factory, preserving its conservative first open. MCP SDK, contained native model,
SQLite/private checkpoints and session delivery are real; provider/model/Hosted
transport is controlled and external network denied. The approved image is unchanged.

Initial source comparison:

| Runtime | Elapsed (incl fixture startup/cleanup) | Catalog calls | Renewal callbacks | Initialization |
| --- | ---: | ---: | ---: | ---: |
|Installed3978 baseline|41.361s|27|7|1|
|Changed source|40.029s|25|7|1|

Both passed:3 model requests,2 tools,1 scoped thread read,1 result commit,
10 ordered activity deliveries, attempt1. Two later model entries share pending
checks; the third/initial entry remains ordered. The fixed25s model delay dominates
this scenario. One sample is not a latency distribution or a live improvement claim.
Final same-driver installed-artifact measurements are reported with the artifact.

Exact installed comparison now passes with the identical driver SHA256 on both
packages: baseline3978 takes41.265s/27catalogs; candidate
`75438a10deb245e172bf07b7435ad321d9b7fa7a` takes40.072s/25catalogs. Both retain all
counts/renewals above. [Comparison JSON](evidence/cypack-1546-inflight-comparison.json).
The17-package bundle and17 resolved installed copies pass source provenance checks.
Installed native memory/work F1 also passes:5 completions,10 model exchanges,
4 applied writes,1 corrected rejection,52 deliveries, lost-ACK reconciliation,
fresh native context on resume and later retrieval. Model/provider/Hosted transport
is controlled; this is not a new live memory or responsiveness claim.

Focused checks:85 passed/1 opt-in skip across automation/MCP/recovery/delivery;
40 passed/1 opt-in skip across timing/interruption/delivery; the final entry suite
with additional unknown/abort cases passes22 tests. These sets overlap. The actual
opt-in native replay regression separately passes1 test with the approved image.
Normal lint/build/typecheck hooks pass. No dependency changes.

The installed candidate also passes the unchanged actual Hosted production
dispatcher/native parent fixture at published
`70ea13bb5429b679c2b7b6391c73bf13ca57c110`:1 test/21 assertions in49.30s.
Three completed occurrences, two parent model continuations, one publication,
lost publication/result/occurrence ACK recovery, dedup and foreign/withdrawn/paused
denial remain. [Joined summary](evidence/cypack-1546-inflight-parent.json).
SQL/callback/dispatch/native execution are real; GitHub/model/wake transport remain
controlled. Earlier independent3978/70ea proof is not relabeled as this candidate.

Use the committed installed profiler with an exact reviewed bundle:

```sh
CYRUS_TEST_DOCKER_PATH=/usr/local/bin/docker \
CYRUS_TEST_DOCKER_HOST=unix:///approved/same-user/docker.sock \
CYRUS_F1_CODEX_IMAGE=sha256:35ffa8e695666695f047cf527138b9b27f2e1c29d44673f9eb705a0e4010be4f \
node apps/f1/catalog-profile.mjs INSTALLED_PREFIX FULL_RUNTIME_SHA NEW_EVIDENCE tools
```

Default greeting mode also exercises cold/warm no-tool turns at150/1500ms. Its
direct pure factory can share the first entry check; that does not establish the
same startup saving for the configured factory's readiness I/O path.

Focused regression coverage holds authorization unresolved and verifies no model
effects, denies revoked/aborted entry, preserves unknown/legacy adapter ordering,
and proves a later authorization call starts another request. Existing lifecycle,
renewal, receipt and SDK tests remain. Real container replay verifies authorization
denial before release of the saved native tool, then legitimate resume succeeds.

## Remaining latency and duration semantics

This removes two sequential round trips in the controlled two-tool scenario,
not the other25 catalog checks. It does not claim to solve the live90s run or its
22s startup; the configured first-open/context path intentionally stays ordered.
The existing `executionDurationMs` measures observed model/tool intervals excluding
blocking authorization/delivery waits, queueing and receipt reconciliation. It
includes provider wait inside those intervals; it is not pure model compute time.
The UI's Worked-for14s therefore is not end-to-end elapsed90s. Hosted was informed
to distinguish those values; this change does not silently redefine the counter.

No live runtime, home, checkpoint, prompt, provider effect or old blocked occurrence
was accessed. Coordinator owns artifact installation and any live timing acceptance.
