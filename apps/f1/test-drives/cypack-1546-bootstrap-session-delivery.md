# CYPACK-1546 paired bootstrap and session delivery

2026-09-29, Node22.17.1, controlled local HTTP transports only. No live account,
provider/model request, tunnel mutation, release or deployment.

Commands after building the CLI/edge-worker packages:

```
node apps/f1/preview-pairing-drive.mjs
node apps/f1/automation-drive.mjs
```

Both passed. Pairing begins without preconfigured workspace/model credentials;
actual AuthCommand/StartCommand obtains authenticated team ID, downloads strict
bootstrap configuration, privately persists it and starts registered capabilities
on the selected preview origin. One auth request, one bootstrap, one launch.
Evidence: `/tmp/cyrus-preview-pairing-f1-5skT8R/summary.json`.

Automation drive uses production runtime, SQLite ledger/checkpoints, session sink
and journal, HTTPS transport classes through a test-only loopback bridge, and real
MCP SDK initialization/list/call/reconnect. It exercises instructions, actual ticks,
queued Slack/Linear inputs, scope denial, revocation, duplicate/out-of-order events,
restart and terminal recovery with the model unavailable. Negotiated session delivery
produced 42 distinct receipts over45 transmissions, with a deliberately lost activity
ACK. Final lifecycle/response receipts precede all7 committed results; one result ACK
is lost and reconciled without reopening tools/model/progress. MCP counts:9initialize,
9list,9tools;15model requests;8progress;8result transmissions;5denials.
Evidence: `/tmp/cyrus-automation-f1-WdPjNh/summary.json`.

A focused runtime regression additionally holds the final activity ACK unavailable
through the first attempt: zero result calls occur. Two process-style restarts then
recover activity/result receipts under new attempt identities; the model executes
only twice and the tool once. Journal source keys prevent duplicate activity appends.

Limitations: fixture authority/provider/model transport is not actual hosted SQL,
live Codex, signature/subscription coverage or UI reload proof. Those gates remain
open. Direct and ticket-backed child execution remain separate implementation work.
