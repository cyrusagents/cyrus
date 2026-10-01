# CYPACK-1546: catalog phase attribution

Test-only instrumentation, unchanged installed runtime
`397813003cccc9e1f936feff3e96987e1b507229`, PR1507.
Actual SQLite/registered HTTP routes, MCP SDK session, native contained Codex,
login broker and durable session delivery. Hosted/provider/model transports are
controlled; no live customer or provider traffic. Container image remains
`sha256:35ffa8e695666695f047cf527138b9b27f2e1c29d44673f9eb705a0e4010be4f`.

F1 applies to the new bounded latency parameter and test-only caller attribution.
The existing greeting profile runs cold/warm at150ms and1500ms per MCP HTTP request.
All original assertions remain: one initial catalog, one initialization, both
authority barriers around native snapshot, ordered ACKs before result, bounded
numeric diagnostics, no tools, two model turns/results per profile. No server
authorization result is cached. Caller instrumentation records only three fixed
code filenames and numeric compiled locations, never raw stacks or payloads.

| MCP HTTP delay | Condition | Total | Native start | Catalog count/sum | Container init |
| --- | --- | ---: | ---: | ---: | ---: |
|150ms|cold|3241ms|1730ms|9 /1419ms|359ms|
|150ms|warm|2840ms|1351ms|9 /1394ms|225ms|
|1500ms|cold|17932ms|9532ms|9 /13537ms|299ms|
|1500ms|warm|17718ms|9484ms|9 /13549ms|263ms|

Each condition creates a fresh native container; warm means the supervisor/image
are warm, not a reused model session. Provider headers82–86ms/body121–122ms are
synthetic. One sample per condition establishes boundary counts, not a performance
distribution. Both profiles pass with11 session deliveries,2 model requests,
2 committed results and18 catalogs. Slow runs cross multiple5s poll intervals
without additional catalog calls: overlapping checks share the current in-flight
`fresh()` promise; completed checks are not reused.

## Why nine calls occur with no model tools

Compiled locations below refer to the exact installed source, captured in
`evidence/catalog-phases/profile-*.json`. Each check reaches one real SDK tools/list.

| Phase | Caller (compiled JS) | Intervening work / boundary |
| --- | --- | --- |
|Initial authority|AutomationRuntime415|Before checkpoint load; new session initialize then one catalog|
|Progress|AutomationRuntime514|After durable session creation/status, before progress|
|Execution loop|AutomationRuntime522|After progress callback, before model/context work|
|Native next|ContainedCodexModel62|Before container initialization or tool-result continuation|
|Model callback|ContainedCodexModel82|Before reading/persisting native snapshot|
|Provider request|CodexLoginBroker191|After snapshot, before credential read/provider request|
|Provider response|CodexLoginBroker239|After provider body, before release into native process|
|Native completion|ContainedCodexModel197|Before final native snapshot|
|Returned model step|AutomationRuntime585|After final snapshot, before pending-step checkpoint|

The final two authority checks use authorize/renew, not catalog, after the runtime
marks the pending result for receipt reconciliation. Final delivery flush remains
between those checks. These are additional HTTP waits, not hidden catalog calls.

tools/list repetition is a runtime current-authority probe, not a requirement of
MCP discovery. Initial connect does not list twice. A tools/call on an existing
session does not itself fetch another catalog; Hosted independently enforces its
current grant and source checks on the tool. Model tool turns add loop/native,
broker, capture, pending-operation, post-tool-result and possibly poll boundaries.
Native-context retrieval adds its own tool request and post-read check.

The runtime loop check and native adapter entry check are adjacent for this simple
greeting. They are potential future consolidation points, not an SDK duplicate:
the generic loop also supports fresh context retrieval, pending recovery and other
model adapters. There is no existing proof-bearing API transferring one current
check across those paths. Removing a check globally would change those guarantees.
Likewise, the two broker-side checks straddle persisted native snapshot work and
cannot be collapsed using a cached authority result. This bounded investigation
does not justify a production check removal; no runtime executable code changed.

Catalogs themselves are serialized by the client's exclusive queue. Their duration
overlaps enclosing authority/model spans and may overlap other activities; do not
add catalog and enclosing-span sums. The live count alone does not identify which
caller awaited each request or which requests blocked first native activity.

The warm1500ms run spends about9s before native start in two initialization HTTP
requests plus four serialized catalog probes. The measured8.133s warm startup
increase is consistent with six requests each delayed an additional1.35s, plus
local variation. This demonstrates amplification of slow authority transport;
it does not assign the actual live33.698s gap or truncated23-catalog trace to
individual callers. Existing live diagnostics lack caller attribution.

Hosted59473f3a separately consolidates SQL within each authorization boundary.
Runtime consumed that handoff; its reported controlled8→3 RPC measurement is not
measured by this fixture. No reduction in live latency is claimed here.

## Reproduction

```sh
CYRUS_TEST_DOCKER_PATH=/usr/local/bin/docker \
CYRUS_TEST_DOCKER_HOST=unix:///var/run/docker.sock \
CYRUS_F1_CODEX_IMAGE=sha256:35ffa8e695666695f047cf527138b9b27f2e1c29d44673f9eb705a0e4010be4f \
node apps/f1/catalog-profile.mjs /tmp/cypack-installed-39781300 \
  397813003cccc9e1f936feff3e96987e1b507229 /tmp/NEW-catalog-profile
```

The runner verifies installed worker/broker source provenance, adapts only driver
import paths, wraps revalidation without changing its return/error semantics and
restores the wrapper on exit. Original driver SHA256 is included in each result.
The installation bundle/hash/image remain unchanged. No live process, home,
checkpoint, customer prompt or retry was accessed.
