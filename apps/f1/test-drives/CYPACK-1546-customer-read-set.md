# CYPACK-1546 customer-derived read-set F1

This slice implements the resource and tool schemas from published Hosted
`0e37517391a930c83ff42a24f80b332b1ee82c10`. Runtime negotiates
`X-Cyrus-Customer-Read-Set:1` and advertises `customerReadSet:true`.
Source proof is the accompanying change based on runtime `f4a5bcbd`;
immutable installed-build proof is supplied separately with the test bundle.

[Native Docker proof](evidence/customer-read-set/native.json) and
[Messages proof](evidence/customer-read-set/messages.json) pass:

- Registered instruction dispatch lists two issues and reads both with opaque
  references on the admitted SDK session. No model-selected authority/provider IDs.
- Forced lease renewal rotates credentials, invalidates old references, and causes
  a bounded re-list instruction before the model reads with new references.
- Source-free replies have zero grants, no MCP initialization, and durable responses.
- Existing scheduled ticks, admitted event queue/restart/dedup, current-authority
  denials, direct/ticket children, private checkpoints and terminal ACK recovery.
- Native only: real Codex app-server in the unchanged immutable image, isolated
  engineering test failure/repair/rerun and publication reconciliation.

Native: 133 activity receipts / 138 deliveries; 17 results / 18 transmissions;
4 read-set provider reads, 2 children / 5 delegation calls, 1 engineering publication
/ 2 calls. Messages: 106 receipts / 110 deliveries; 16 results / 17 transmissions.
Both use controlled model/provider/authority transports; no live provider/model calls.

Reproduce after `pnpm build` with the image preloaded:

```sh
CYRUS_F1_CODEX_IMAGE=sha256:35ffa8e695666695f047cf527138b9b27f2e1c29d44673f9eb705a0e4010be4f \
node --input-type=module -e 'const {runAutomationDrive}=await import("./apps/f1/automation-drive.mjs"); console.log(JSON.stringify(await runAutomationDrive(),null,2));'
```

Omit the image variable for Messages-only coverage. Daemon overrides are
`CYRUS_TEST_DOCKER_PATH` and `CYRUS_TEST_DOCKER_HOST`; production containment is
unchanged. See `docs/contained-codex-image.md` for immutable build/load requirements.

Actual SDK regressions cover forged fields, cross-session/rotated references,
foreign customer result envelopes, absent tools and revocation on an open session.
A runtime regression aborts an active model when its current session grant is
revoked without extending or rotating that credential. Exact Hosted schema
comparison passes [13 valid / 78 denial cases](evidence/customer-read-set/hosted-contract.json).
That comparison is schema interoperability, not a joined Hosted SQL/provider run.

The [initial integrated fixture failure](evidence/customer-read-set/initial-fixture-failure.txt)
is preserved: separately sampled equal-duration lease/token clocks could produce
a token one millisecond later than its lease. Runtime correctly refused it. The
fixture lease now exceeds the token by one second; no authorization was relaxed.
An initial unit fixture also used a token shorter than the admitted schema minimum;
it was corrected. The initial full suite had an existing 50ms chat queue timing
assertion fail under concurrent load; isolated rerun passed. Final checks are
recorded with the immutable artifact.

Remaining gates: actual Hosted SQL + installed runtime read-set join, current
association/revocation checks and live mapped Linear reads through the preview.
Customer-bound delegation is schema-compatible but intentionally withheld by the
published Hosted permissions until narrowing is implemented. Existing fixed-resource
direct/ticket delegation remains supported. No live Slack acceptance, release,
published minimum version, merge or production enablement is claimed.
