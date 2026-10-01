# CYPACK-1546: bounded finished latency retention and startup profiling

PR1507; baseline installed source4733183c20d259e2b7f383c9e447d8bf565276f3.
This test changes optional diagnostic persistence, not authority, model execution,
MCP checks, session timing or delivery/receipt barriers. F1 applies to authenticated
status retrieval after runtime recreation; unchanged feature joins are not rerun.

## Controlled baseline

Actual installed17-package runtime, SQLite, MCP SDK, contained Codex/app-server,
login broker with synthetic credential and fixed model response. Immutable arm64
image35ffa8e695666695f047cf527138b9b27f2e1c29d44673f9eb705a0e4010be4f;
author Docker socket /var/run/docker.sock. No network/mounts/pull in container.
Host gateway/provider transport is controlled, external requests denied. Injected
40ms per Hosted callback,150ms per read-set MCP HTTP,80ms provider headers and120ms
body. Hosted timing headers are fixed synthetic measurements, not actual SQL proof.

| Profile | Total | Native start offset | Container initialization | Provider headers/body |
| --- | ---: | ---: | ---: | ---: |
| Source-free cold |2514ms|1430ms|517ms|90/123ms|
| Source-free warm |1642ms|716ms|249ms|112/123ms|
| Read-set cold |3184ms|1558ms|382ms|85/121ms|
| Read-set warm |2812ms|1346ms|225ms|87/120ms|

“Warm” reuses supervisor/image, not native session/container. Each profile has two
attempt1 greeting occurrences, zero tools, two model requests and two result commits.
Raw fixed numeric traces are in `evidence/latency-retention/baseline-*.json`.

Warm read-set boundaries:
- Dispatch enqueue0.5ms, queue<0.1ms, SQLite claim0.4ms; admission44ms.
- After admission, initial authority467ms contains initialize313ms (initialize and
  initialized-notification transport) and catalog153ms. Local checkpoint read0.2ms.
- Session create48ms. Initial status delivery overlaps current authorization;
  progress44ms follows authorization. Two more current checks precede container.
- Container225ms, thread12ms, turn/start4ms; first native marker1346ms and model
  request1361ms. A marker is not a browser-visible token.
- Model callback to credential357ms: current catalog157ms, snapshot43ms, another
  current catalog157ms. Credential read0.4ms. Provider headers/body87/120ms.
- Response release and native completion retain current checks. Final session ACK
  flush95ms, result43ms, cleanup92ms. Final deliveries precede result.

This reproduces serialized authority transport, not an intrinsic model-compute
cost. Container/native initialization and snapshot are necessary isolated execution
work with variable host cost; measured model response is synthetic. No measured
SQLite/queue bottleneck or removable runtime wait justifies relaxing authority.
Hosted owns profiling its repeated tools/list authorization pipeline. Existing
90ff/e978 live spans lacked these fine boundaries; neither this profile nor prior
roundtrip savings assigns the historical44s or passes live responsiveness.
Native-context retrieval, delegated work and combined-source provider timings are
not measured by these greeting profiles. No live prompt was sent to obtain evidence.

## Retention change and acceptance

Separate operator opt-in in addition to collection: completed attempt diagnostics
only, strict fixed numeric/flag schema, private0700 directory/0600 per-workspace
SQLite file.64 entries/128 spans/2MiB JSON/4MiB database,24h eligibility. Hashed internal
lookup keys, no raw identities/content/credentials. No diagnostic state enters
admission or recovery. Busy/corrupt/unsafe/failed storage cannot fail a run.

Relevant unit coverage checks workspace separation, restart/retry, stale writer,
TTL/count/byte bounds, malformed data, symlinks/permissions, lock contention and
failure isolation. Runtime F1 recreates the registered handler/runtime, retrieves
identical finished diagnostics through authenticated opt-in status, asserts ordinary
and disabled status omission,401 without auth and no additional model/result/tool
activity. Ordered ACK assertions and both current checks around snapshot remain.

Reproduction (source build, installed version replaces only package import paths):

```js
await runAutomationDrive({
  latencyOnly: true, latencyReadSet: true, latencyRetention: true,
  sessionDeliveryAuthority: true,
  codexImage: 'sha256:35ffa8e695666695f047cf527138b9b27f2e1c29d44673f9eb705a0e4010be4f'
});
```

Source retention F1 passed, including disabled collection after recreation.
Focused latency/retention/Hosted-header/runtime tests:84PASS/1existing opt-in skip.
Build and typecheck pass. Exact installed artifact evidence follows the source commit.

With the69-span read-set trace, a local70-save diagnostic I/O profile retained64
entries: median save3.90ms, p95 12.66ms, maximum233.57ms; one bounded status read3.28ms.
This optional synchronous disk cost is outside the attempt trace and can perturb
other supervisor work on a slow filesystem. It is an explicit diagnostic tradeoff,
not a hidden claim of zero overhead or a reason to enable it on a live runtime.
Count/size bounds do not guarantee filesystem wall-clock latency.
This is opt-in observability, not a claimed latency reduction. Finished trace save
is after cleanup/outside the measured attempt; crash before save can lose diagnostics.
No live3456/4444 process, home, checkpoint, customer data or8007 was changed.
