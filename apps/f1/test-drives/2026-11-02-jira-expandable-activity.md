# Jira expandable activity and public summaries

Date: November 2, 2026

Runtime product commit: `9d4169733177ef49e74c0f07e2d9a5065b1d4659`.
Hosted product commit: `0f574f81ed3b912e448f4e96c27fb0991c354e1f`.

## Scenario and result

The real F1 EdgeWorker, isolated Codex runner (`gpt-6.1-sol`), authenticated HTTP bridge, Hosted service and database migrations processed a bounded disposable-repository task. Forge signatures and Jira authorization were local fixtures in this drive; this is not actual Jira UI proof.

The task solved a small scheduling example, ran two separate shell tools (`pwd`, then a 12-second wait and marker), and returned the requested marker. Codex emitted the public summary **Calculating value ranges**, which reached the durable runtime journal before terminal completion. Hidden reasoning was not captured.

The client disconnected after live progress, subscribed again, and reconstructed the response from the opening snapshot plus append chunks. It matched GetTask exactly: one Thinking section, two completed Command sections, then the answer. Retrying the original request replayed the same task with no second execution. Terminal subscription was refused with A2A -32004. All 27 assertions passed; the runtime stayed running for the user's tests.

The first test attempt exposed an assertion helper that assumed every SSE frame contained status; an artifact frame caused that helper to throw. The helper was corrected to ignore non-status frames, its owned task was canceled, and the complete scenario then passed.

## Evidence and limits

Task `6cd7caad-21ac-4f96-aa7e-13dc5c03ef4c`, context `79c95b3c-ee4c-41e2-9f38-0864b24fa451`.
Local operator receipts: `expandable-joined-receipt.json`, `expandable-joined.log` and `expandable-joined-live.test.ts` under `/Users/connor/.codex/task-runs/jira-agent-connector/`.

Separate automated checks passed 95 Codex-runner tests, 23 focused Jira activity/config tests, and 36 Hosted streaming tests. The real provider's visual expansion/collapse, history and reconnect rendering remain a separate browser acceptance gate; this report does not claim them.
