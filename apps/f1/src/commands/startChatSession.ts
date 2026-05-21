/**
 * Start Chat Session command - Dispatch a synthetic Slack chat event
 * through the EdgeWorker's chat session handler.
 *
 * Hits the F1-only REST endpoint `/cli/dispatch-chat` exposed by server.ts.
 */

import { Command } from "commander";
import { error, gray, success } from "../utils/colors.js";
import { formatKeyValue } from "../utils/output.js";

interface DispatchChatResponse {
	ok: boolean;
	eventId?: string;
	threadKey?: string;
	error?: string;
}

function getDispatchUrl(): string {
	const port = process.env.CYRUS_PORT || "3600";
	return `http://localhost:${port}/cli/dispatch-chat`;
}

export function createStartChatSessionCommand(): Command {
	const cmd = new Command("start-chat-session");

	cmd
		.description(
			"Dispatch a synthetic Slack app_mention event into the EdgeWorker chat handler",
		)
		.option(
			"-c, --channel <id>",
			"Slack channel ID (default: C_F1_CHAN)",
			"C_F1_CHAN",
		)
		.option(
			"-u, --user <id>",
			"Slack user ID issuing the mention (default: U_F1_USER)",
			"U_F1_USER",
		)
		.option("-t, --text <text>", "Message text (default: hello)", "hello")
		.option(
			"-T, --thread-ts <ts>",
			"Thread timestamp to reuse an existing chat thread",
		)
		.action(
			async (options: {
				channel: string;
				user: string;
				text: string;
				threadTs?: string;
			}) => {
				const url = getDispatchUrl();
				console.error(gray(`POST ${url}`));

				try {
					const response = await fetch(url, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							channel: options.channel,
							user: options.user,
							text: options.text,
							threadTs: options.threadTs,
						}),
					});

					if (!response.ok) {
						throw new Error(`HTTP ${response.status}: ${response.statusText}`);
					}

					const data = (await response.json()) as DispatchChatResponse;

					if (!data.ok) {
						throw new Error(data.error || "Unknown dispatch error");
					}

					console.log(success("Chat event dispatched"));
					if (data.eventId) {
						console.log(`  ${formatKeyValue("Event ID", data.eventId)}`);
					}
					if (data.threadKey) {
						console.log(`  ${formatKeyValue("Thread Key", data.threadKey)}`);
					}
				} catch (err) {
					if (err instanceof Error) {
						console.error(
							error(`Failed to dispatch chat event: ${err.message}`),
						);
						process.exit(1);
					}
					throw err;
				}
			},
		);

	return cmd;
}
