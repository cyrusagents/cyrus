# Installed trusted-PM owning-team gate

The bounded joined drive uses Runtime executable
`23811dfadc78bf12549319435c4f94a81b79705b`, driver
`8a32ffe29dd504de8520c94d78b9e7c86b6c443c`, and frozen Hosted
`ebf27fd91a14eec19e56d28ce2ccfb4302891ad9`.

It reuses Hosted's existing PM fixture, production admission/delivery/session
adapters, real migrated SQL and installed registered Runtime/normal CodexRunner.
Test-only overlays affect a disposable source archive, not either checkout's
production implementation. The app-server, model and provider are controlled.
The installed executable remains unchanged; no new installation is required.

**PASS: 4 tests, 310 assertions, 62.75 seconds.**

## Assertions

| Case | Expected execution boundary |
| --- | --- |
| Initial OFF | Real queued submission reaches admission after eligibility withdrawal; no runner construction, native start, tool or result. |
| Queued withdrawal | ON admission waits behind the actual runner semaphore. OFF revalidation after releasing the slot denies native start; no tools or result. |
| Active withdrawal | One controlled native/tool turn starts while ON. OFF stops it, denies retries and commits no result. |
| Terminal recovery | One native turn commits a result, loses its ACK, then becomes ineligible. A second attempt reconciles identical result key/text without new native/tool/progress/configuration work. |

All denied occurrences retain the bounded three-attempt/fence behavior. The
terminal occurrence completes on attempt/fence 2 with one SQL result commit and
two result transmissions. Recovery is admitted with `phase: reconcile`, without
a customer MCP descriptor. Private PM results never fan out to customer events
or messages.

The terminal replay includes one existing session-creation receipt (sequence 1)
under fence 2. Its item digest matches the original exactly. SQL journal status,
last sequence and receipt count do not change; no new activity/progress is
persisted. This legitimate immutable receipt replay is distinguished from new
execution or fresh session authority.

## Reproduction and evidence

Run the command in `apps/f1/trusted-pm/README.md` with these exact inputs and a
new evidence directory. No image pull, live provider credentials, registration,
flag changes or service restart are required. The adjacent JSON contains the
four sanitized case summaries; full local logs remain under the CYPACK-1546
`attachments/rollout-gate-1002/pm-gate-8a32` evidence directory.

The first diagnostic run passed initial/queued cases but incorrectly changed
immutable input for an active-turn hold and asserted a nonexistent reconciliation
field. SQL rejected the input change. The fixture now holds its controlled
app-server without touching admitted input and asserts `authority.phase`.
Subsequent receipt diagnostics corrected an overstrict no-delivery assumption:
measurement proved exact existing sequence-1 replay, not additional activity.
Failed logs remain in the same attachment root; none is presented as a pass.

This closes the installed PM marker-specific proof gap, not a live PM/provider
acceptance claim or instantaneous cancellation of an already in-flight ordinary
provider operation. The unpatched node-forge publication hold, coordinator review
and live installation capability restrictions remain unchanged.
