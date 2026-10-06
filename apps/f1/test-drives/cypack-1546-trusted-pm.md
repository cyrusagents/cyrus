# CYPACK-1546: subsequent PM and disclosure phase

Behavior changed: authenticated customer Linear disclosure, one-way engineering
submission, and a distinct registered normal PM runner. Relevant F1 is required;
these drives target that path rather than repeating historical engineering flows.

- Customer contained native drive: **PASS**, 5 model steps, 1 submission through
  lost referenced-write ACK, 1 result commit/2 transmissions, 18 private activity
  receipts. Strict restricted and verified-email projections, no PM tools or
  callback, fresh native transcript and changed-epoch terminal recovery asserted.
- Registered PM normal-runner drive: **PASS**, 2 runner opens (completed plus
  deliberately revoked), 1 result commit/2 transmissions, 14 private receipts,
  35 admissions. Actual registration HTTP, SQLite, normal CodexRunner subprocess
  transport and formatter/sink. No customer parent/fanout. Configured repository
  withdrawal does not reopen model work during immutable result recovery.
- Focused regressions: 108 PASS/1 existing opt-in skip across 6 edge-worker files;
  12 PASS across 4 affected Codex files. Extra SDK/slot regression: 20 PASS.

Evidence: [customer native](evidence/trusted-pm-customer-policy/customer-native.json)
and [registered PM](evidence/trusted-pm-customer-policy/registered-pm.json).
Reproduction and installed-path overrides: [drive README](../trusted-pm/README.md).

The first PM stub omitted its required formatter; corrected to the actual Codex
formatter before the successful drive. The initial customer fixture token was
below the production schema minimum; corrected synthetic token, no production
validation weakened. Source/installed provenance is recorded in the resulting
artifact handoff; model/provider/Hosted transports are controlled. PM's native
app-server is also controlled; the customer container uses actual native Codex.
Actual published Hosted SQL/dispatch and independent live verification remain
open. No live installation, customer prompt, provider write or release occurred.
