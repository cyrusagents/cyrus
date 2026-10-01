# Scoped MCP startup latency: LIVE-LATENCY-1001

Runtime PR1507; baseline e978131ad3b7ebb4f2ac5c7e3c72ff49512bb6a8.
Exact replacement source/package SHA and raw timings accompany the local test bundle.

Changed behavior: first revalidation initializes the actual MCP SDK and admits one
catalog instead of fetching it twice. Every established-session revalidation still
checks the remote authority. Added fixed, bounded diagnostic spans for SDK queue,
initialization/catalog, actual authority refresh, SQLite checkpoint binding and native
rollout capture. No live process, registration or source was used.

## Reproduction

Use the preloaded Linux arm64 image
`sha256:35ffa8e695666695f047cf527138b9b27f2e1c29d44673f9eb705a0e4010be4f`
and an explicitly authorized disposable Docker socket. Build the packages, then:

```sh
CYRUS_TEST_DOCKER_HOST=unix:///var/run/docker.sock \
CYRUS_F1_CODEX_IMAGE=sha256:35ffa8e695666695f047cf527138b9b27f2e1c29d44673f9eb705a0e4010be4f \
node --input-type=module -e 'const {runAutomationDrive}=await import("./apps/f1/automation-drive.mjs"); console.log(JSON.stringify(await runAutomationDrive({latencyOnly:true,latencyReadSet:true,sessionDeliveryAuthority:true}),null,2))'
```

For installed testing, replace the driver's package imports with the disposable
installation roots; invoke its exported function explicitly. No global registration,
config, provider connection or real model credential is required. The existing F1
fixture supplies all synthetic credentials and enforces loopback-only transport.

## Assertions and observations

- Production registered routes, SQLite, checkpoint/session journal, gateway, MCP SDK,
  Codex broker and actual isolated native container; controlled HTTP/model providers.
- Admitted customer read-set exposes exactly list_issues/get_issue. Deterministic
  model greets without calling either. Cold and warm means two different occurrences
  in one supervisor, each with its own new native container/session.
- Both attempts complete once, zero tool calls, two result commits. Final session
  receipts precede result. Authenticated opt-in status contains fixed numeric spans;
  ordinary status excludes them, unauthenticated status is401, no fixture secrets.
- Inject150ms per MCP HTTP request,40ms other Hosted requests,80ms provider headers,
  120ms provider body. Installed e978 baseline:20 tools/list requests; fixed source:18.
  Warm admit→checkpoint629ms→481ms. Cold724ms→489ms includes host variance.
- New fixed spans show one initial catalog and two current-authority catalog gates
  around native snapshot before credential.read. Snapshot38–48ms; each gated catalog
  153–158ms in the source run. These spans are nested/overlapping, not additive totals.
- Red/green real SDK regression: original first revalidation sends2 catalogs, failing
  expected1; fixed sends1, second revalidation contacts Hosted again. Existing rotation,
  delayed reads/writes, cross-session references, malformed catalog, revocation,
  oversize/abort and immutable write-key tests remain required.

No claim that the older44s gap is explained or live responsiveness passes. The90ff
passive trace identifies the paths but lacks per-MCP/snapshot timing. This patch
removes a proven redundant request and makes remaining authorization waits visible;
no cached authority or skipped security/receipt barrier is introduced. See
`docs/automation-latency-diagnostics.md` for observed versus inferred accounting.
