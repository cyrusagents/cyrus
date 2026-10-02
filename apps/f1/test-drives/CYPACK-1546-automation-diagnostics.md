# CYPACK-1546 safe failure diagnostics

Runtime `ee59271a` discarded every admission/execution exception before recording
retry status. This slice persists only bounded phase/code/HTTP status/static
schema section names/time in `lastFailure` on the existing occurrence/status API.
No error bodies, arbitrary messages/field names, inputs or credentials are stored.

[Registered HTTP F1](evidence/automation-diagnostics/messages.json) passed with an
actual local authority returning403. Three attempts end blocked without model/MCP
startup, and authenticated status exposes `authorize/http_denied/403`; unauthenticated
status denies. The same drive retains instruction/tick/event/restart, read-set
rotation, direct/ticket delegation and result/activity recovery coverage.

Reproduce after `pnpm build`:

```sh
node --input-type=module -e 'const {runAutomationDrive}=await import("./apps/f1/automation-drive.mjs"); console.log(JSON.stringify(await runAutomationDrive(),null,2));'
```

Targeted regression tests persist HTTP/schema/identity/MCP failures before any
checkpoint, reopen SQLite after exhaustion, reject sensitive raw messages and
untrusted schema keys, fence stale failure writers, and clear diagnostics after
success. Actual SDK tests retain MCP HTTP401 through wrapped initialization and
revocation failures. Existing scoped MCP/engineering tests remain covered.

These are controlled transports, no live provider/model calls. The verifier's
existing live occurrence was not resent, reopened or changed. Hosted independently
identified its initial MCP401 after successful authorize200 and fixed omission of
the required nullable PostgREST `p_session` argument in `b58ec56b`. The runtime
cannot reconstruct errors discarded by the previous installed version. This patch
improves future visibility, not proof of live recovery or permission to retry.
