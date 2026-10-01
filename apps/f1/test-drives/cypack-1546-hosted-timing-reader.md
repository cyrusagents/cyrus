# Optional Hosted timing reader

Parent runtime90ff76a57399c859d39fd5dd6067bce37812538d; candidate:this commit.
Hosted frozen00847f21c86c526d090a931d44d707573023a6c7. Date2026-10-01 UTC.

Changed behavior: only collected supervisor callback spans opt into Hosted timing;
strict bounded response metrics attach separately to the runtime transport span.
Normal status, authority, callbacks, immutable receipts and final ACK gates remain.

Actual frozen Hosted HTTP handler + production runtime transport drive:

```
mkdir /absolute/new-frozen-hosted
 git -C /absolute/hosted-checkout archive 00847f21c86c526d090a931d44d707573023a6c7 | tar -x -C /absolute/new-frozen-hosted
# Install frozen dependencies, or link already installed dependency directories only.
bun --no-env-file apps/f1/hosted-timing-drive.mjs /absolute/new-frozen-hosted
```

The drive imports actual Hosted callback/session handlers and RequestTimings, runs
real loopback HTTP and production runtime gateway/sink classes. It injects controlled
authentication/storage dependencies, not SQL or providers.18requests cover ordinary
header absence, admission/renewal, progress/result/interruption, receipt replay,
authorization denial, failed commit, invalid ACK, a delayed callback final ACK,
missing/exact/wrong marker, malformed/oversized/unknown/duplicate metrics and capped
output from Hosted's emitter.40ms injected outside handler time stays distinguishable
from Hosted's20ms callback/commit wait. Loaded handler hashes are recorded. No
production TLS weakening; the test-only fetch transport redirects a fixed fixture
origin and denies other network access. No live runtime or provider credentials.

The existing native latency F1 runs with `latencyOnly:true,sessionDeliveryAuthority:true`
and the approved35ffa8e6 image. Its controlled Hosted transport emits fixed numeric
metrics; two real isolated native turns must retain them on corresponding callback
spans, keep runtime durations separate, expose them only through authenticated opt-in
status, and ACK every session receipt before result. Model/header/body waits stay
separate. Installed replay imports only exact source-stamped packaged modules.

Parser/privacy tests cover all8metrics, finite/bounded/precision constraints, fixed
flags, exact marker,401, immutable snapshots, rejected unknown labels, capped trace
retention and absence of diagnostic options on model spans. An initial oversized
fixture used trailing whitespace normalized away by Headers; corrected to internal
padding so the consumer actually receives >1KB. No production limit was relaxed.

Evidence and exact artifact/source/hash are in the owner handoff. This is controlled
handler/transport + native proof, not new live/SQL/provider acceptance or an explanation
of historical44s. Preserve coordinator-installed90ff,3456,4444 and all checkpoints.
