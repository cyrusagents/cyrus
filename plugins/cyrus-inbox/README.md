# Cyrus Inbox

This package connects to the Hosted incoming MCP endpoint. Deploy the paired
CYHOST-1356 Hosted change, its automatic production-merge migration, and server
configuration before connecting. The committed endpoint is the production
Cyrus origin; for an isolated preview, copy this folder and replace only the
origin in `mcp.json`. Do not put credentials in this package.

Import this plugin directory using your host's supported private plugin import,
or register its deployed HTTPS MCP endpoint in the ChatGPT developer plugin
flow. Review the OAuth consent in your selected Cyrus workspace. Call
`get_inbox`, then explicitly instruct a **dot or Cloud Work chat** to monitor
`cyrus.message.created` for that inbox and specify the intended action. Either
Franco dot or an existing Cloud Work chat is acceptable for first acceptance.
No new conversation or operator transfer is implied by installation.

Give the inbox ID to the authorized Cyrus operator. Enable
`mcp__cyrus-tools__post_message_to_codex` in the applicable runtime tool settings,
then publish `{inboxId, idempotencyKey, text}`. The runtime uses its configured
Hosted API key and the server enforces that the inbox belongs to that team.
Use a unique operation key (at least 8 characters) and preserve it on retries.

`queued` means durable acceptance; `webhook_received` means a callback acknowledged
receipt. Neither means the model ran. Capture the receiving agent's actual
response and message ID before declaring end-to-end acceptance. Delivery normally
starts on the next minute's cron tick. Expiring subscriptions are refreshed by
the host. Stop monitoring to unsubscribe; use the connection management link
from the consent page to revoke the entire grant.

Native local Codex wakeups are **not implemented or claimed**. App Server's
`thread/resume` / `turn/start` are explicit integration APIs, not a native MCP
Events listener for an existing local chat.

References: [Events](https://developers.openai.com/plugins/build/mcp-events),
[packaging](https://developers.openai.com/plugins/build/plugins),
[App Server](https://learn.chatgpt.com/docs/app-server).
