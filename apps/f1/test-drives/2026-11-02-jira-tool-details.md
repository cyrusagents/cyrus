# Jira selected tool details

This drive exercises changed runtime activity rendering, so F1 applies. The real F1 EdgeWorker and isolated Codex runner (`gpt-6.1-sol`) ran against a disposable repository through the authenticated HTTP bridge and actual Hosted service/migrations. Forge/Jira identity was synthetic; provider UI is a separate acceptance gate.

Tested product commits: runtime `4ea9c570a246e4f6dc022b07691f7c8d1315c9e8`, Hosted `6bf7da2f019c6d1a65dc72711335f6d2dbf15ed4`.

The task ran `pwd`, then a separate 12-second sleep/marker command. Both actual normalized command strings survived runtime extraction, durable activity storage, Hosted parsing, a disconnected stream, resubscription and final polling. The response contained two completed Bash sections with fenced commands, followed by the final answer. Repeating the original message reused the same task and did not execute it again; subscribing after completion returned the expected terminal error. No public summary was emitted in this turn; none was invented.

Result: **31 assertions passed**, two tool starts/two finishes, one task, zero remaining active streams. Task `7015b99b-9dfe-40ca-9af2-5f1e89fbc6bf`, context `4273f308-10d1-45e9-b73f-44c39146f497`. Operator receipts: `tool-details-joined-receipt.json`, `tool-details-joined.log` and `tool-details-joined-live.test.ts` under `/Users/connor/.codex/task-runs/jira-agent-connector/`.

Unit/service tests separately cover credential syntax and known-value redaction, omission of embedded payloads and arbitrary tool output, copied correlation state, failed journal writes, output withholding, byte bounds and malformed detail rejection. Display filtering is not a guarantee of recognizing arbitrary encoded secrets. Only selected inputs and trusted outcomes are exposed; this is not full Linear output parity.

The user-requested test runtime remains running. The existing issue-card versus Rovo-chat rendering discrepancy remains unresolved; this joined drive does not establish browser rendering or production readiness.
