# Authority watchdog — installed native regression

Executable `6a099aeeb3994251e0433c4b37b4eb8c633eaf3e`, baseline installed
`03ce05d2e3475880a3db886418055256f9d306e6`. Both use the same profile driver,
negotiated lifecycle callbacks, 800 ms synthetic Hosted delay and the approved
native Codex image. No live runtime or customer is involved.

The watchdog now schedules from the latest actual authority request start instead
of an unrelated fixed timer phase. Every action still makes or joins a current
request; no completed decision is reused. The deterministic regression holds the
final receipt ACK after an action check at four seconds: old code unnecessarily
polls at five seconds, while new code polls at nine and still stops immediately
when that current request observes revocation. No result is sent. The old code
fails the counter assertion; four focused lifecycle/recovery/interruption/
engineering suites pass **71 tests, one optional skip** after the change.

## Controlled installed comparison

| MCP delay | Build | Cold total / native start | Warm total / native start | Catalogs per turn | Receipt renewals cold / warm |
| --- | --- | ---: | ---: | ---: | ---: |
| 150 ms | 03ce | 8.235 / 3.696 s | 7.558 / 3.392 s | 7 | 1 / 1 |
| 150 ms | 6a09 | 8.018 / 3.376 s | 7.105 / 3.356 s | 7 | 0 / 0 |
| 1500 ms | 03ce | 21.629 / 10.099 s | 20.286 / 9.876 s | 8 | 1 cancelled / 0 |
| 1500 ms | 6a09 | 21.287 / 10.003 s | 20.446 / 10.015 s | 8 | 0 / 0 |

Each condition passes two fresh native turns, zero model tools, two committed
results and eleven activity deliveries with ordered final ACKs. Provider headers
80 ms/body 120 ms are synthetic. The read-set profile does not reproduce the
additional automatic context retrieval of the live customer path. Host scheduling
variance remains visible: the slower-MCP warm run is 160 ms slower, not a speedup.
The timer correction eliminates redundant receipt requests, but does not solve
startup or establish live responsiveness acceptance.

The original profile assumed every callback span had HTTP timing headers. A
successful result can instead abort an outstanding renewal during cleanup. The
corrected assertion permits missing headers only for a failed renewal that began
after the result request and spans cleanup; all other callback header assertions
remain strict. Deliberately lost ACKs with received headers retain their checks.
The failed profiles and bounded diagnostic output are preserved, not overwritten.

Replay with the verifier's approved same-user Docker binary/socket:

```sh
CYRUS_F1_LIFECYCLE_AUTHORITY=1 CYRUS_F1_HOSTED_DELAY_MS=800 \
CYRUS_F1_CODEX_IMAGE=sha256:35ffa8e695666695f047cf527138b9b27f2e1c29d44673f9eb705a0e4010be4f \
node apps/f1/catalog-profile.mjs INSTALLED_PREFIX SOURCE_SHA NEW_OUTPUT
```

## Actual Hosted join

Installed 6a09 against frozen Hosted
`4f9b7b26e51edde54969d6862bf83a48ddaa10ed` passes the unchanged combined,
tool-rejection and negotiated-lifecycle native join in **119.43 s**. It verifies
22 negotiated admissions, 149 checkpoint saves, eleven completed occurrences,
132 activity deliveries and 27 controlled model requests. Fourteen result
transmissions include lost-ACK recovery and a denied callback, not fourteen
committed results. Both receiver-side Pause cases deny progress/result with HTTP
409 and no customer reply. The combined 47-second model delay retains same-session
renewal, opaque references and secondary-source withdrawal. Ordinary memory/work,
immutable rejection/write receipts and terminal reconciliation remain covered.

The actual installed Runtime, native Docker, MCP SDK, published HTTP handlers and
migrated SQL execute. Model/provider/source-event admissions are controlled.
This is not live provider, preview UI or cloud outage acceptance. Existing legacy,
engineering and old-checkpoint negatives pass in the focused unit suites; there
is no change to their negotiated contract or action boundaries.

Reproduce using the flags and command from the lifecycle-authority report, replacing
the Runtime SHA/prefix with 6a09. Immutable artifact SHA256:
`0bf50d179fa4903e8c428b664d042ca4f668c141018d07d7f283b98ea048dc2f`.
All 17 packages and 17 installed copies match executable source. No package was
published and no minimum published version is claimed.

Evidence in issue attachments: `watchdog-6a099aee/` (artifact, comparison, exact
helper hashes, logs and handoff), `watchdog-before-03ce-verified/`, and
`watchdog-join-4f9b-6a09/`. See `docs/automation-watchdog-timing.md` for passive
live trace attribution and remaining Hosted-side cost. Live 3456/4444, customer
state and old blocked occurrences were untouched.
