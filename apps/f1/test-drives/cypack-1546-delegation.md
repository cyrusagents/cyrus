# CYPACK-1546: model-requested investigation children

Runtime implementation: the commit containing this report, following executor
commit `05f1267fd0673b94acb702f87d3436937fb08fba` and native adapter
`a40d0bc632b3123b8d175effceeb549837a1430e`. Matching Hosted contract:
`26e68bcf37b1e764c1cf61fe0ef8b2d6c5bfb5d1`, ACK 2a712269.

Changed workflows require F1: negotiated delegation discovery/admission, model
tool selection, real SDK MCP dispatch and durable direct/ticket child execution.
The production registered HTTP routes, SQLite ledger, scoped checkpoint/journal,
native Codex process and SDK transport are real. Hosted authority, provider and
model responses are local controlled fixtures; external network is denied.

After `pnpm build`, run with Node 22+:

```sh
CYRUS_F1_CODEX_IMAGE=sha256:35ffa8e695666695f047cf527138b9b27f2e1c29d44673f9eb705a0e4010be4f \
node --input-type=module -e 'const {runAutomationDrive}=await import("./apps/f1/automation-drive.mjs"); console.log(JSON.stringify(await runAutomationDrive(),null,2));'
node --input-type=module -e 'const {runAutomationDrive}=await import("./apps/f1/automation-drive.mjs"); console.log(JSON.stringify(await runAutomationDrive(),null,2));'
```

Use `CYRUS_TEST_DOCKER_HOST`/`CYRUS_TEST_DOCKER_PATH` for the authorized local
daemon/binary. No image pull, publication or live login is used in these drives.

Both adapters passed. The model requested direct and assigned-ticket children,
repeated each identical payload, and encountered one deliberately lost delegation
ACK. Five actual tool calls committed exactly two assignments. Children ran through
registered admission with separate read authority, checkpoints and activities;
the exact admitted parent/ticket linkage survived. No Linear session or issue was
created for direct children. Ticket tracking associates the already-bound fixture
issue; it is not evidence of a real provider ticket assignment/creation.

Native: 91 immutable activity receipts / 95 deliveries, 13 result commits / 14 sends,
18 MCP initialize/list sessions, 15 unique tool operations, five denial probes.
Messages: 78 receipts / 82 deliveries, same result/tool/denial counts. Summaries are
in `evidence/delegation/`. Existing instruction/tick/event, restart, revoked-session,
cross-customer and terminal receipt-only cases passed. 63 automation/MCP/session
tests passed with the actual native image enabled, including worker delegation
denial and strict extra-field/argument checks.

The first extended drive asserted local completion immediately after the gateway
committed a result; both adapters exposed that fixture race. The corrected drive
waits for the local receipt ACK/completed state before asserting it. It does not
change production execution. Original failed logs remain in `/tmp`.

## Engineering executor prerequisite

At `05f1267f`, the existing Docker executor supports supervisor-selected Node or
default Bun. Real-container Unicode handoff/snapshot testing reproduced corrupted
UTF-8 when Docker chunk boundaries split a character; bounded byte buffering fixes
it. Forty targeted tests passed, including Node/Bun repair after a normal nonzero
test exit and stop/deny on timeout, abort and output overflow.

`apps/f1/scoped-runtime-drive.ts` passed on both reviewed immutable images. Select
`CYRUS_TEST_SANDBOX_RUNTIME=node` with the native image above, or default Bun with
the existing preloaded Bun image, and explicitly set `CYRUS_TEST_DOCKER_HOST` and
`CYRUS_TEST_SANDBOX_IMAGE`. Both exercised repair/retest, preserved pre-failure edits,
publication/result callback, worker-write denial, renewable leases and terminal
receipt recovery. This is a regression of the retained executor foundation; it
does not enable a legacy fallback or prove redesigned registered engineering.

Hosted SQL/provider/UI joining of this new delegation head remains separate from
these controlled drives. Shared-assignment engineering admission/publication and
cross-scope lineage still require the agreed Hosted extension. No live Slack,
release, merge, production enablement or customer effects are claimed.
