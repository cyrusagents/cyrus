# Negotiated current-admission delivery

Date: 2026-09-30. Parent runtime: `0df27c781f4c0bedf0d4b2a19f3ceb0b1952b59d`.
Candidate: this commit. Hosted: `5a54b0db04a2f0c8ca511c545906cf4b63c8d73e`.

Only exact `sessionDeliveryAuthority: "current-admission-v1"` permits customer
coordinator/investigator journal delivery without a separate remote preflight.
Abort, local lease/credential deadline and workspace/readiness checks remain;
Hosted checks current admission on every request. Engineering/absent/unknown retain
preflight. Exact mode is pinned on renewal and persisted checkpoint restoration.
No cached ACK/authority, model/tool/progress change or final-receipt shortcut.

Focused runtime tests cover expiry of either deadline, local abort, receiver
revocation, periodic revocation during model work, malformed receipt, mode changes,
root/direct/ticket session recovery, engineering exclusion and ordered final flush.
An initial fixture used two clock reads for equal deadlines, producing occasional
invalid credential expiry under load. One captured deadline fixed the fixture;
production validation was unchanged. Failure logs remain in the evidence folder.

The existing disposable native F1 harness measures cold/warm turns with500ms per
Hosted request. Parent installed profile: startup4533/4323ms, final native→result
5473/4613ms, total11709/11039ms. Candidate source profile: startup4003/3847ms,
final native→result4102/3607ms, total9902/9168ms. Native intervals remain~1.6s.
These are controlled latency observations, not attribution of historical live44s.
Each turn has a fresh isolated native container; model/provider/Hosted transports
are fixtures, with no live accounts, prompts, workspaces or runtime homes involved.

Actual Hosted boundary/join proof uses the unchanged frozen5a54 fixture with local
disposable SQL, actual HTTP handlers and runtime SQLite. Source joint:82PASS,
800assertions, including initial/append/replay/current-deadline lock-wait boundaries
and automatic lost-result-ACK reconciliation. Wrapper imports add only assertions:
all19 admission responses advertise the exact mode and all6 checkpoint saves pin it.
They do not alter production classes, payloads or transport. Model/provider fixtures
remain controlled; this joined run is not a native container or live-provider proof.

Exact artifact/installed before-after traces, source generators, wrapper source,
commands/hashes, failures and final receipts:
`/Users/agentops/.cyrus/CYPACK-1546/attachments/delivery-authority-profile/`.
The final artifact handoff records the immutable candidate head and installed replay.
Source fixture option: `runAutomationDrive({sessionDeliveryAuthority:true})`;
false retains the old path for comparison. The canonical driver keeps its existing
strict receipts/current grant gate and namespace isolation. Production HTTPS is
unchanged; only fixture transport redirects the fixed origin to loopback.

Same preloaded native image:
`sha256:35ffa8e695666695f047cf527138b9b27f2e1c29d44673f9eb705a0e4010be4f`.
Use an explicitly authorized local Docker socket. No author live installation,
customer message/retry, original8007 change, merge, release or deployment.
