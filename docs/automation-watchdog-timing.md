# Current-authority watchdog timing

CYPACK-1546 / [PR #1507](https://github.com/cyrusagents/cyrus/pull/1507).

The watchdog is a backstop while an execution is idle or waiting. Every action
still starts, or joins an outstanding, current authority request. No successful
permission decision is cached for a later action.

Previously the watchdog ran on a fixed five-second phase from execution startup.
An action could finish a current check shortly before the next timer tick, then
wait for another check during final receipt delivery. The timer now measures its
interval from the **start of the latest actual authority request**. An outstanding
request remains the sole check; if it runs past that interval, its settlement
re-arms the watchdog immediately. Local lease/credential deadlines, failure abort,
near-expiry renewal, model/provider/tool checks and ordered final receipt ACKs
remain unchanged. This applies to watchdog scheduling, not to admission policy
or the optional lifecycle-authority contract.

## Observed live attribution

These are the verifier's passive numeric observations from installed
`03ce05d2e3475880a3db886418055256f9d306e6`, not measurements of this candidate.
The source is shared evidence
`2026-10-01-03ce-5e01-greeting-numeric-timing-112339.json` and its foreground DOM
capture, on the feature alias at Hosted `5e01`.

| Stage | Observed duration |
| --- | ---: |
| Runtime dispatch to completion | 24.919 s |
| Foreground send to visible final reply | 38.847 s |
| Queue wait | 0.024 ms |
| Admission | 2.257 s |
| Initial MCP initialization + catalog | 3.059 s |
| Session creation | 0.490 s |
| Running progress callback | 1.089 s |
| Context preflight | 1.444 s |
| Context call interval inferred from adjacent queue/check spans | about 1.928 s |
| Context-result authority check | 1.236 s |
| Model-entry authority check | 1.847 s |
| Container + native thread initialization | 0.335 s |
| Dispatch to native turn start | 13.775 s |
| Nine MCP catalog requests, summed | 13.294 s |
| Provider response headers + body | 1.237 s |

Nested and overlapping spans must not be added together. In particular the
catalog sum includes checks inside the named stages. The context call lacks its
own completed duration span; its interval is a code-grounded inference, not an
independent measurement. The difference between runtime and DOM elapsed is not
assigned to a single transport/UI stage by this evidence. The active-work label
also measures a different interval from operator-perceived elapsed time.

The final model-result check started at 20.308 s and finished at 21.528 s. Final
receipt flush finished at 22.486 s. The old fixed-phase watchdog nevertheless
started renewal at 22.293 s; the result callback waited until 24.291 s. That is a
concrete redundant timer-phase wait. The candidate changes that phase, without
skipping result-handler current authorization. A fixed-phase check can also
happen to overlap provider work beneficially, so the controlled comparison must
report both cold and warm results rather than promise a uniform latency gain.

The dominant pre-native cost is serialized remote admission/context/authority
work, not the 335 ms container startup. Hosted has the separate code-review
handoff for duplicate same-request connection lookups and root/child selection
lookups in catalog authorization. Runtime does not replace those checks with a
cached permission or edit Hosted's implementation.

The older approximately 44-second pre-native examples lacked this complete
telemetry. This newer trace does not retroactively establish their exact cause.
The candidate and controlled fixtures do not close live responsiveness acceptance.
