#!/usr/bin/env node
// Deliberately controlled Codex app-server, no model, provider or outbound network.
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

if (
	process.env.CYRUS_API_KEY ||
	process.env.CYRUS_TEAM_ID ||
	process.env.CLOUDFLARE_TOKEN
)
	process.exit(23);
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const notify = (method, params) => emit({ method, params });
let threadId;
for await (const line of createInterface({ input: process.stdin })) {
	const { id, method, params } = JSON.parse(line);
	if (id === undefined) continue;
	if (method === "initialize")
		emit({ id, result: { userAgent: "controlled-pm-fixture" } });
	else if (method === "thread/start" || method === "thread/resume") {
		threadId = params.threadId ?? randomUUID();
		emit({ id, result: { thread: { id: threadId } } });
	} else if (method === "turn/start") {
		const turnId = randomUUID();
		if (!JSON.stringify(params.input).includes("untrusted customer request"))
			throw Error("Missing submission boundary");
		emit({ id, result: { turn: { id: turnId } } });
		notify("turn/started", { threadId, turn: { id: turnId } });
		const tool = {
			id: randomUUID(),
			type: "mcpToolCall",
			server: "linear",
			tool: "get_issue",
			arguments: { id: "PM-1" },
			status: "inProgress",
		};
		notify("item/started", { threadId, turnId, item: tool });
		notify("item/completed", {
			threadId,
			turnId,
			item: {
				...tool,
				status: "completed",
				result: { content: [{ type: "text", text: "PRIVATE_PM_FINDING" }] },
			},
		});
		if (JSON.stringify(params.input).includes("WAIT_REVOCATION")) continue;
		notify("item/completed", {
			threadId,
			turnId,
			item: {
				id: randomUUID(),
				type: "agentMessage",
				text: "PRIVATE_PM_FINDING",
			},
		});
		notify("turn/completed", {
			threadId,
			turn: { id: turnId, status: "completed" },
		});
	} else if (method === "turn/interrupt") emit({ id, result: {} });
	else emit({ id, result: {} });
}
