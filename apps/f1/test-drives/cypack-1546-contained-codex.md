# CYPACK-1546: contained native Codex and child sessions

Behavior changed: registered automation harness selection, native Codex process and
login broker, private native recovery, admitted direct/ticket child execution and
durable activity delivery. F1 applies to these runtime/session workflows.

The drive uses production AutomationRuntime, HTTP registered routes, SQLite,
CodexLoginBroker, native Codex 0.153.3 in an actual isolated Docker container, and
MCP SDK client/server initialize/list/call/reconnect. Only hosted authority,
provider replies and model SSE responses are controlled local fixtures. Login
material is synthetic in a private temporary fixture home; every external network
request is rejected. No live model/provider calls or customer effects occurred.

After building packages:

```sh
CYRUS_F1_CODEX_IMAGE=sha256:35ffa8e695666695f047cf527138b9b27f2e1c29d44673f9eb705a0e4010be4f node apps/f1/automation-drive.mjs
node apps/f1/automation-drive.mjs
```

Image provenance and same-user socket requirements: [image handoff](../../../docs/contained-codex-image.md).
Set CYRUS_TEST_DOCKER_PATH for a different absolute Docker binary. Current fixture
uses the agentops test daemon at unix:///var/run/docker.sock; production supports
an explicit same-user socket and does not assume that daemon is available to Connor.

Both drives passed instruction, scheduled tick, non-customer automation, admitted
Slack/Linear events while idle/running, duplicate/out-of-order delivery, restart,
pause/revocation denial, separate customer checkpoints, direct and ticket-backed
investigator children, lost activity ACK and receipt-only lost-result recovery.
The native drive recorded 63 immutable activity receipts / 66 deliveries, nine
committed results / ten result transmissions and five denial probes. Messages
regression recorded 54 receipts / 57 deliveries with the same result/denial counts.
Machine summaries are preserved in `evidence/contained-codex/`.

An additional real-container regression interrupts after native tool admission,
reopens the private checkpoint, returns the same pending request before another
model call, restores the same native thread in a fresh container, and continues
using durable tool output. Process tests verify no inherited credentials, host
files/socket or external network; native tool-start/result/final normalization;
command timeout; abort; and bounded unterminated stdout/stderr. Registered readiness
probes the real isolated app-server with a synthetic private login.

The first drive exposed native goal tools appearing in persistent Codex sessions;
the supervisor broker rejected them. Explicitly disabling goals and other
unneeded native integrations resolved that failure without widening the broker.
Historical earlier evidence remains unchanged.

This is not acceptance of hosted SQL/UI, live ChatGPT login refresh, live Linear
permissions/assigned-ticket creation, or full contained engineering publication.
The ticket descriptor and Slack traffic are synthetic. Other native built-in tool
activity timelines are not asserted. No release, merge or production enablement.
