# Customer lifecycle callback latency — installed native comparison

Executable `03ce05d2e3475880a3db886418055256f9d306e6`, baseline installed
`d66ed0a86d0d925fe88469a142da93f640aee416`. Both run the same controlled driver
with an offered lifecycle capability. Baseline does not negotiate the header;
03ce opts in. No live runtime/customer/provider request is made.

The changed behavior replaces the extra pre-progress and two terminal receipt
preflights only when customer handlers explicitly guarantee current authority.
Every receiving progress/activity/result handler remains authoritative. F1 applies
to this runtime change and exercises installed HTTP/SQLite/MCP SDK, private native
Docker, the existing login broker fixture and durable activity ACKs.

| MCP transport delay | Build | Cold total/start | Warm total/start | Catalogs/turn | Receipt renewals/turn |
| --- | --- | ---: | ---: | ---: | ---: |
|150ms|d66|3.123/1.581s|2.750/1.245s|8|2|
|150ms|03ce|3.201/1.452s|2.553/1.146s|7|0|
|1500ms|d66|16.388/8.012s|16.174/7.953s|8|2|
|1500ms|03ce|14.629/6.441s|14.614/6.450s|7|0|

Each condition starts two fresh contained native sessions; warm reuses only the
supervisor/image. Two model turns, zero model tools, two result commits and ordered
final ACKs pass. Both remote checks around native snapshot/provider work remain.
1500ms warm saving1.560s is consistent with one fewer1500ms catalog plus two40ms
callback roundtrips; host variance remains visible in the150ms cold total. Provider
headers80ms/body120ms and other Hosted40ms are synthetic. No live speed acceptance
or attribution of the20.153s outside Runtime follows from these measurements.

Exact profile source/hash/counts are retained in issue attachments:
`lifecycle-d66-before/profile-*.json`, `lifecycle-03ce05d2/profile/profile-*.json`.
Artifact SHA256 `a2b7cef01b3ec03049491bf7d62b7f944b8dd135e6b9b6b99bcb96969198bfd1`;
17packages/17resolvedcopies match source. Image unchanged:
`sha256:35ffa8e695666695f047cf527138b9b27f2e1c29d44673f9eb705a0e4010be4f`.

Focused lifecycle/recovery/interruption/MCP/engineering suite72PASS/1optionalSKIP.
Opt-in actual Docker native checkpoint recovery/revoked replay separately1PASS.
Lifecycle35tests cover absent/unknown negotiation, actual handler revocation,
wrongACK/abort/expiry, near-expiry renewal, periodic revocation, engineering fallback,
stored-mode changes and historical checkpoint recovery without model reopen.
Normal lint/build/typecheck hooks pass.

Replay the profile using the unchanged approved Docker binary/socket environment:

```sh
CYRUS_F1_LIFECYCLE_AUTHORITY=1 \
CYRUS_F1_CODEX_IMAGE=sha256:35ffa8e695666695f047cf527138b9b27f2e1c29d44673f9eb705a0e4010be4f \
node apps/f1/catalog-profile.mjs INSTALLED_PREFIX \
  03ce05d2e3475880a3db886418055256f9d306e6 NEW_EVIDENCE_DIRECTORY
```

Full installed native F1 also passes:143unique activity receipts/149deliveries,
19result commits/20transmissions,47model requests,5denials and6same-session renewals
across slow model turns. Includes owner interruption, direct/ticket children,
engineering failing-test repair/publication and immutable receipt recovery. Its
Hosted/provider/model transports remain controlled; see native-summary.json.

The actual Hosted0cc Workflow transport-retry join independently passes87/933
(documented in the direct-successor report). Hosted lifecycle opt-in proof remains
pending explicit server negotiation; the0cc retry gate uses legacy preflight.
The existing preview remains coordinator-owned.
