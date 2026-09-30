# Opt-in live withdrawal probe (CYPACK-1546)

This is test instrumentation for the existing registered supervisor, not a runtime
API. No production package imports these files. The preloader accepts only the
feature preview origin and the unpublished runtime source
`134a8a48fd97ffae01fe5328c098ff0d1e719f43`. It does not install or launch another
runtime, admit a grant, change SQLite, pause a customer, or contact a provider on
its own. The verifier owns all live actions and the existing Connor process/home.

The runtime's normal abort/reference guards intentionally prevent a server-side
withdrawal proof. This harness wraps its scoped client only when explicitly loaded.
At a successful target `get_issue` boundary it enters that client's existing exclusive
queue. Renewal/close/normal tool work wait behind the barrier. Credential, exact SDK
session, negotiated protocol version and reference remain in this closure's memory.
A real SDK reconnect transport reuses that existing session without initialize. Its
only possible requests are `tools/list` and fixed `get_issue({reference})`. The probe
uses its own bounded cancellation signal so the normal client's aborted signal
cannot substitute for a Hosted denial. Production guards and authority are unchanged.
No model arguments select probe credentials, tool names, scope or references. While
armed, the exact target occurrence also denies any normal non-read MCP operation
before dispatch, so a model cannot delegate/send/write during this read-only test.
Other occurrences and uninstrumented runtime behavior remain unchanged.

After successful pause/resume probes, the barrier releases with a test interruption:
the original read's pending operation remains unchanged for normal admission/retry.
The first current `list_issues` under a later attempt/fence and different session
probes the old reference. The complete admitted definition/input/occurrence must
match the captured scope. A subsequent normal newly referenced read completes the
probe. Raw tokens, references, sessions, private output and provider IDs are never
returned over control or saved in evidence. This uses private class/SDK fields and
is deliberately pinned to the reviewed installed version, not a general SDK API.

## Prerequisites and launch — verifier only

Use only `https://cyrus-preview-cyhost-1321.vercel.app` for browser/auth/runtime.
Verify its current target head, correct workspace/runtime and exclusive disposable
Alpha association through existing authorized surfaces. Confirm no other Alpha work
is active. Record original pause state and current revision; inspect the existing
Connor command, environment and package prefix. Preserve port3456/home/pairing,
model login, native image/socket and unrelated agentops4444. No reauthentication,
credential copying, shared Docker ACL change or package upgrade is needed.

Extract the reviewed harness archive to a private directory owned by Connor. Create
another fresh `0700` control directory, for example with
`mktemp -d /private/tmp/cyrus-withdrawal.XXXXXX`. Write `config.json` mode0600 inside
it. Values below are schema/examples; substitute the existing installed package
path and current DB-derived automation revision. Never include credentials:

```json
{
  "runtimePackage": "/ABSOLUTE/EXISTING/PREFIX/lib/node_modules/cyrus-edge-worker",
  "sourceSha": "134a8a48fd97ffae01fe5328c098ff0d1e719f43",
  "directory": "/private/tmp/cyrus-withdrawal.UNIQUE",
  "workspaceId": "caed9b61-c184-4ae2-9c2c-f25174760764",
  "automationId": "31991de1-1c06-4195-8792-bf59f5a49427",
  "revision": 1,
  "scopeRef": "8c3bc266-e6fc-4065-9be3-7cc57ae0c03a",
  "linearCustomerId": "59ec83ef-9a11-4971-b731-1b94bb382b5f"
}
```

scopeRef is the INTERNAL customer identity; BOTH authority.definition.scopeRef and namespace
must match it. linearCustomerId is the EXTERNAL Linear Customer ID in the admitted
grant resource; it must match separately. They are deliberately distinct.
The revision above is illustrative, not authority. Read the current revision first.
The package manifest must carry the exact `cyrusLocalTestArtifact.sourceSha` above.
A mismatch, insecure config/directory, wrong origin or existing socket fails startup;
the preloader never deletes an existing socket. Do not use a shared evidence folder
as the private control directory.

At a verifier-approved idle boundary, replace only the existing preview process
using its same command/env with these two additions:

```sh
CYRUS_F1_WITHDRAWAL_CONFIG=/private/tmp/cyrus-withdrawal.UNIQUE/config.json \
CYRUS_APP_URL=https://cyrus-preview-cyhost-1321.vercel.app/ \
node --import /ABSOLUTE/HARNESS/withdrawal-probe-preload.mjs \
  /EXISTING/PREFIX/lib/node_modules/cyrus-ai/dist/src/app.js \
  --cyrus-home EXISTING_PREVIEW_HOME start
```

Preserve all other existing launch settings explicitly, including chosen port,
Docker socket/image and model setup. Use direct `--import`, never `NODE_OPTIONS`
(which could propagate instrumentation to subprocesses). Startup prints only
`private control ready; not armed`. Recheck normal capabilities and connections.
No HTTP route is added. Controls use an owner-only0600 Unix socket under0700 parent.

## Pause and revision semantics

Read at Hosted `c29bd989859faf43beecb2e1fb436144cfbaf16c`: the customer UI calls
`customerCommand({op:'pause',paused:...})`, which calls `customer_operator`.
Migration `20260929010000_customer_agents.sql` pause branch updates only `paused`
and customer `generation`, and revokes running runs. It does NOT increment customer
policy revision, mutate the automation binding, or emit a new definition revision.
`ensureCustomerConversation` also retains an existing binding when customer revision
and source are unchanged. This is distinct from configuring an automation/policy or
changing a mapping. Hosted owns confirmation with its actual SQL operator fixture.

The test therefore pins the original occurrence AND definition/revision throughout.
After normal Pause/Resume, fresh admission uses new run/execution/session authority
while the original immutable definition/input and operation keys remain unchanged.
No exception to runtime checkpoint scope is introduced. If the verifier observes a
binding revision change (including a concurrent configuration change), STOP the
same-occurrence recovery gate and cancel the probe. Do not loosen identity checks or
call Resume saved work on the stale revision. CYPACK cancels nonterminal old-revision
occurrences and returns409 to a stale retry; the second F1 scenario proves this path
with one initial read, no new read/result and withdrawalGateComplete=false. That
outcome is not a successful live withdrawal/recovery test. Coordinate the changed
binding before another bounded test; the harness never creates one automatically.

## One bounded test

Use `node /ABSOLUTE/HARNESS/withdrawal-probe-control.mjs PRIVATE_DIR OP [VALUE]`.

1. Admit one fresh read-only Alpha instruction through the normal UI. Ask it to
   list/read the disposable issue and re-list after an interrupted session. Obtain
   the actual occurrence ID using existing authenticated status surfaces, then
   `arm EXACT_OCCURRENCE_ID` before the first read completes. The arm cannot change
   automation/workspace/customer/revision or admit work. Missing the boundary is
   inconclusive; do not silently create another prompt. The arm lifetime is10min.
2. `status` until `phase=ready`. This means actual normal initialize/list/read
   succeeded and the queue is held. Evidence exposes only safe attempt/fence IDs
   and remaining milliseconds. Readiness requires at least20s before the earlier
   token/lease deadline. The hold ends at45s or1s before that deadline, whichever is
   earlier; no renewal extends this window. Have the existing Pause UI ready.
3. Click Pause once, confirm its fresh successful response. Immediately run
   `probe-paused ACTUAL_CONFIRMATION_ISO_TIMESTAMP`. Both tools/list and old-reference
   read must produce actual HTTP401, with `httpObserved=true`, `requestCount=1`,
   and both unexpired booleans true. Each probe is bounded to8s and natural expiry.
   No local abort/reference error counts as pass. Use the actual recorded response
   timestamp, not an invented earlier value. UI send rejection remains a separate
   verifier check and must not consume the short hold window unnecessarily.
4. Restore Alpha with Resume once and confirm success. Immediately run
   `probe-resumed ACTUAL_CONFIRMATION_ISO_TIMESTAMP`. The retained old credential
   must still get actual401 before expiry. Success releases the held queue; its
   ordinary pending read is interrupted and preserved for normal recovery.
5. Let normal authority/lease recovery proceed. If the original occurrence exhausts
   its bounded cycle, use the existing exact-occurrence Resume saved work action
   once as in the Hosted plan. Do not edit the ledger, manufacture attempts or add
   another instruction. A new current list triggers the old-reference probe on that
   newly admitted session. Evidence must show HTTP response and MCP-32600 (or an
   earlier401); a fresh normal list/reference read must then succeed. If the model
   completes without re-listing, this phase is inconclusive, not automatic permission
   for another prompt. `phase=complete` includes the successful current read, but
   verifier must additionally confirm ordinary result/session persistence and UI.
6. Verify mappings/connections and Beta unchanged. This proves pause revocation,
   not removal/restoration of a customer mapping. Do not substitute SQL, provider
   disconnect or CustomerNeed deletion for the absent mapping-withdrawal UI.

Only `status`, `arm`, `probe-paused`, `probe-resumed`, `cancel` are accepted, with
strict exact fields. Commands do not repeat network probes after phase advancement;
use status after a lost control response. Controls can reject expired/late commands.
A timeout, network failure, wrong HTTP/MCP status or unexpected success is never pass.
If a phase is inconclusive, restore original Alpha pause state via the UI, inspect
the original occurrence and coordinate; the harness never performs that restoration.

## Cleanup and evidence

`cancel` releases queued work, clears retained private references/credentials and
restores the normal client method. Successful completion and timeout do the same.
The harmless private status socket remains until process exit. After verifying the
occurrence/restoration, the verifier may restart only this preview process with the
original command, removing `--import` and `CYRUS_F1_WITHDRAWAL_CONFIG`. Preserve all
runtime files/config/ledger; no rollback of runtime packages is needed. Confirm the
owning process has stopped before removing a stale control socket/private directory.

`evidence.json` is written atomically mode0600 and contains sanitized timing/status
only. Inspect then copy this file alone into shared evidence, alongside alias/head,
pause receipts and independent UI/result observations. Never copy config/auth homes,
checkpoints, raw provider output or process memory. A server HTTP response proves
receipt at the configured Hosted origin; live provider-call counts are not inferred
from absence of data or a401. Existing controlled/source checks establish ordering.

## Reproduction

After `pnpm build`:

```sh
pnpm --filter cyrus-f1 test:run withdrawal-probe.test.mjs
node apps/f1/withdrawal-probe-drive.mjs
node apps/f1/withdrawal-probe-drive.mjs --revision-change
```

The narrow F1 uses actual registered instruction/wake routes, SQLite, runtime class,
MCP SDK and normal two-attempt recovery with controlled authority/model/provider.
It aborts the original local client before the denial probes, holds queued renewal,
asserts three actual401s plus new-session HTTP200/MCP-32600, and completes a fresh
read/result. It performs exactly two synthetic provider reads and no writes. This
is not live Hosted SQL/browser/model or container acceptance. Production containment
and the existing immutable image are unchanged; historical native F1 remains intact.
