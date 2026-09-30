# Opt-in live withdrawal probe (CYPACK-1546)

The default `pause` mode retains the accepted Pause behavior. Explicit
`mode:"source-withdrawal"` uses the separate revision/occurrence flow below. Do not
use the historical6227 Pause-only archive for source removal.

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

## One bounded Pause test (default mode)

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

## Source-withdrawal mode — verifier only

Use the same exact installed134a runtime, private files/socket, origin pin and direct
`--import` launch described above. Add `"mode":"source-withdrawal"` to config.
Internal scopeRef and external linearCustomerId remain separate fixed identities.
Record starting binding revision R from current authority; never use the sample1
as authority. This mode cannot use `probe-paused`/`probe-resumed` and never restores
an old occurrence. Do not repeat the accepted live Pause test.

Hosted migration43 removal advances policy/generation and emits a newer source-free
root definition. This MUST cancel nonterminal old-revision work. Picker reconnect
restores only the mapping; a new operator instruction can then upgrade the binding
and admit new work. Old inputs/checkpoints/operation keys remain with the cancelled
occurrence. No automatic retry/rebinding or test-directed ledger changes are used.
The harness observes tools only: cancellation, retry denial, binding ACK and UI/result
persistence require independent normal authenticated status evidence.

1. Preflight the alias target/head/migration43, only disposable Alpha mapped to the
   intended external customer/account, no unrelated active work, Beta/connection
   baseline and original schedule. Schedule stays off. Prepare the exact Remove
   confirmation and existing-customer picker; credentials never enter control files.
2. Admit one bounded read-only instruction normally; `arm OLD_OCCURRENCE` before its
   first read completes. Wait `phase=ready`. Source mode requires40s remaining old
   lease/token window. Hold still max45s or1s before expiry. Late boundaries are
   inconclusive; no automatic repeat.
3. Confirm supported **Connected records → Remove** for the exact mapping. Immediately
   run `probe-removed ACTUAL_REMOVE_ACK_ISO`. Require removed-list AND removed-read
   actualHTTP401, requestCount1, both unexpired booleans true. The barrier releases
   immediately in `removed-proven` so definition delivery/runtime stop can proceed.
   Credentials/reference remain private in memory; renewal cannot revive that run.
4. Verify delivered newer revision and OLD_OCCURRENCE cancelled. If verifier's gate
   invokes the supported exact old-revision retry, it must return409. Never use
   Resume saved work as recovery or manually edit SQLite. A failure to cancel is a
   failed gate, even if later reads succeed.
5. Reconnect the same external record via normal picker to the SAME existing Alpha
   customer (not Create new), preserving account/connection. Immediately run
   `probe-reconnected ACTUAL_CONNECT_ACK_ISO` before the ORIGINAL token/lease expiry.
   Require actualHTTP401 with unexpired evidence. Expiry, local failure or a late
   picker response is inconclusive, not proof of continued revocation. Do not extend
   leases or repeat Remove to fit the test. Restore mapping as authorized and report
   the missing proof. Successful phase `reconnected-proven` drops the old token from
   the probe, retaining only private stale reference and identity metadata.
6. Submit ONE NEW read-only instruction normally. Obtain its exact current binding
   revision N>R and NEW_OCCURRENCE!=OLD_OCCURRENCE from authenticated status. Before
   its first list finishes, run:
   `node withdrawal-probe-control.mjs PRIVATE_DIR arm-current NEW_OCCURRENCE N`.
   This command only selects what the harness observes; it cannot register/admit
   work or choose scope/account/resources. Same/older revision, old occurrence,
   undeclared fields and changing workspace/customer through control are rejected.
   Missing this boundary is inconclusive; never replay old work to manufacture proof.
7. Under the separately admitted new session, a fixed old-reference read must reach
   Hosted and deny (HTTP200/MCP-32600 or401). Then normal fresh list/get must succeed.
   Harness additionally requires identical resource/account/connection/permissions,
   internal scope and external customer; rotating grant ID may differ. It does not
   compare whole definitions across these deliberately different revisions and
   inputs. No runtime/checkpoint comparison is changed. Attempt/session must differ;
   fences are occurrence-local, so the new occurrence may correctly start at1.
8. Require `phase=complete` AND normal new result/timeline persistence after reload,
   old occurrence STILL cancelled, Beta/connection unchanged, schedule still off.
   Cleanup/cancel/remove preload using the shared procedure. Copy only sanitized
   evidence. `complete` alone does not attest SQL cancellation or UI restoration.

The overall10min instrumentation lifetime still applies; extending it is not an
implicit permission to rerun instructions. Fresh model work may outlast the original
credential; the continued-old-credential denial is proved at step5 before expiry,
whereas the old-reference test uses the new session's current credential at step7.
These are distinct timestamps/claims. No provider-call count is inferred from401.

Reproduce the new controlled path with:
`node apps/f1/withdrawal-probe-drive.mjs --source-withdrawal`.
It delivers revisions1→2→3 through the real registered API, observes cancellation
and authenticated stale retry409, then a DIFFERENT revision3 occurrence completes
at attempt/fence1. It uses actual runtime/SQLite/SDK with synthetic mapping authority,
model and providers; Hosted SQL/UI/live Linear remain independent verifier coverage.
