# Authorized CYHOST-1321 preview runtime handoff

Connor's coordinator owns inspection, installation and pairing under `connor`.
Internal Cyrus remains under `agentops`. Do not change an unrelated runtime,
reuse production registration, or create another workspace. Obtain the code from
the existing onboarding at
`https://cyrus-preview-cyhost-1321.vercel.app/settings/reauthenticate`.
No code or credential belongs in comments, evidence or logs.
Use only this alias for browser/OAuth/device pairing and QA. Verify its target
deployment/head before every live test. Immutable deployment URLs are provenance
only; do not use them as alternate authentication entrypoints or change callbacks
to accommodate their redirects. Parent CYHOST-1304 remains closed.

The exact immutable source, unpublished bundle path and SHA256 are supplied in
the CYPACK-1546/CYHOST-1321 artifact comment. This is a test install, not an npm
release or a minimum published version. Historical `e28e3df1` has green Node22/24
CI and the automation milestone, but use the later corrected pairing artifact:
the older auth client put codes in query parameters.

## Coordinator preflight

1. Inspect Connor's existing runtime process, executable, selected Cyrus home,
   launch configuration and workspace association without dumping argv/auth codes
   or `.env` contents into shared output. Stop only the selected preview runtime
   if needed; do not re-pair unrelated work. Keep any local backup private.
2. Independently verify the supplied bundle SHA256, then extract and run its
   `install.sh` into a new coordinator-chosen writable prefix. Do not overwrite
   the global installation. All 17 package manifests must agree on
   `cyrusLocalTestArtifact.sourceSha` and the candidate version. This is distinct
   from `cyrusTestRelease` registry provenance. `scripts/verify-local-artifact.mjs`
   provides the existing installed-package check.
3. Use Node22+ with built-in SQLite (tested 22.17.1) explicitly. The entrypoint is
   `<prefix>/lib/node_modules/cyrus-ai/dist/src/app.js`; `<prefix>/bin/cyrus` is
   its normal executable link. Calling the entrypoint with the selected Node
   avoids a PATH-selected old Node or a different global Cyrus binary.
4. Verify the selected preview origin and existing workspace identity before
   auth. `auth` rewrites the selected home's `.env` and immediately starts Cyrus.
   It is not a passive credential check. The corrected client sends the code in
   an Authorization header, refuses redirects, sanitizes pairing errors, writes
   private mode0600 credentials and persists the origin. The launch-selected
   `CYRUS_APP_URL` survives `.env` reload; changing origin requires a deliberate
   restart. Hosted `/api/config` auth-prefix logging must also be removed before
   credential-free live pairing is accepted.

For a custom local port, check the feature tunnel's managed ingress independently.
The token-based client calls `Tunnel.withToken(token)`; the local port does not
override Cloudflare's remotely managed origin. Hosted's original tunnel setup uses
`http://localhost:3456`. A separate preview listener on50967 can therefore be
healthy locally while the feature hostname routes to an unrelated listener.
Four Cloudflare connections establish connector connectivity only.

The client now observes managed configuration and reports `unverified`,
`matches-local-port` or `mismatch`, without logging raw config/credentials. This
is a diagnostic, not authenticated route identity or model readiness. Unknown or
unparsed configuration is not proof of routing. Hosted owns reconciliation of
ONLY the selected feature workspace tunnel; the coordinator must then compare
an authenticated routed response with the intended local runtime/workspace.
Do not change the unrelated runtime or rotate tokens to correct an origin port.
Configuration delivery and contained model readiness remain separate gates even
after routing matches. The controlled
[routing F1](../apps/f1/test-drives/2026-09-29-tunnel-routing.md) is not evidence
that the live feature tunnel was reconciled.

Commands below use placeholders deliberately. The coordinator selects the
existing home and prefix after inspection, obtains the code privately and avoids
shell tracing/history capture. Do not paste a real code into a shared command.

```sh
# Existing home and newly installed prefix, selected by the coordinator.
CYRUS_APP_URL=https://cyrus-preview-cyhost-1321.vercel.app/ \
  /path/to/node22 /chosen/prefix/lib/node_modules/cyrus-ai/dist/src/app.js \
  --cyrus-home /existing/connor/cyrus-home auth "$CYRUS_PREVIEW_AUTH_CODE"

# Subsequent restart: same origin, binary and existing home.
CYRUS_APP_URL=https://cyrus-preview-cyhost-1321.vercel.app/ \
  /path/to/node22 /chosen/prefix/lib/node_modules/cyrus-ai/dist/src/app.js \
  --cyrus-home /existing/connor/cyrus-home start
```

## Readiness before feature execution

Verify the installed version with that exact entrypoint, and compare the hosted
registered workspace/runtime association against the existing onboarded workspace.
After registration, securely query the runtime's authenticated
`GET /api/automations/v1/capabilities` using the current paired runtime credential.
Do not put credentials in a URL, command transcript or evidence. Record only the
allowlisted result and expected workspace match. Hosted ownership/fence evidence
must show the registered instance; a local PID or successful HTTP connection is
not proof of registered ownership. Reject mismatched identity or unsupported
contract/capabilities; there is no legacy-runner fallback.

Current automation readiness requires `contractVersion=1`, `available=true`,
matching workspace, an explicit configured `claude-*` model, and an existing
runtime `ANTHROPIC_API_KEY` connection. No new provider credential is requested
by this handoff. OAuth-only Claude, Codex and other harnesses report unavailable
for this contained automation adapter. A discovered unavailable reason is a
blocking result, not permission to change model architecture or use broad native
tools. The new shared session sink is separate plumbing; it does not add a
contained Codex runner or complete the hosted session timeline.

Expected supported capabilities are automations, scheduledTicks, eventInputs,
scopedMcp, currentAuthorityResume and resultReconciliation. harnessStreaming,
nativeTools, sharedMemory and engineering remain false. General read automation
does not require Docker; historical engineering-container evidence does not prove
engineering through this redesigned entrypoint. `minimumPublishedVersion` is null.

Pairing/readiness is a setup gate. Live Codex tool/final persistence with UI reload,
both delegation paths, hosted event delivery and the final engineering workflow
still require their own joint tests. No merge, release, production enablement or
unrelated customer effects are authorized by this handoff.

## Live Linear verification and current coverage

The coordinator reports successful pairing of the f09 candidate to the feature
preview and a connected Linear account. Before any scoped provider access, the
coordinator must verify the actual connected account/organization, existing Cyrus
workspace, isolated test issue permissions, and server-side customer/resource
mapping. A connected account or an online tunnel alone does not establish these.
Use the preview alias above and verify its deployment/head before each live test.
Do not rotate pairing credentials again to recover configuration delivery.

The fresh preview home still needs normal configuration delivery, including its
authenticated workspace identity. This is independent of contained model
readiness: the selected preview model is Codex/gpt-5.5, which the current contained
adapter does not yet support. Keep both conditions visible; do not replace the
selected model with agentops credentials or fall back to a legacy native runner.
The earlier controlled pairing F1 pre-populates its workspace/model environment;
it does not prove bootstrap of an empty home after leaving the browser page.

Once those runtime dependencies and the coordinator's mapping checks pass, the
live Linear gate is an operator instruction and scheduled tick reading only the
admitted issue, followed by a relevant signed issue update waking idle work and
an update retained during active work for the next turn. Record exact runtime and
hosted heads, denied cross-resource requests before provider access, and persisted
results after refresh/reconnect. No customer messaging is authorized here.

Slack has no connected live test workspace/channel available. Keep its existing
controlled/synthetic transport and event coverage separately labeled. Live Slack
acceptance requires that connection, an isolated channel/thread and verified
server-side mapping; its absence does not block the Linear path and is not a live
Slack pass.
