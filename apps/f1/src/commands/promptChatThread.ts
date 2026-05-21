/**
 * Prompt Chat Thread command - Send an additional message to an existing
 * chat thread by replaying through the synthetic Slack dispatch endpoint.
 */

import { Command } from "commander";
import { error, gray, success } from "../utils/colors.js";
import { formatKeyValue } from "../utils/output.js";

interface DispatchResponse {
	ok: boolean;
	eventId?: string;
	threadKey?: string;
	error?: string;
}

function getUrl(): string {
	const port = process.env.CYRUS_PORT || "3600";
	return `http://localhost:${port}/cli/dispatch-chat`;
}

function splitThreadKey(threadKey: string): {
	channel: string;
	threadTs: string;
} {
	const idx = threadKey.lastIndexOf(":");
	if (idx <= 0 || idx === threadKey.length - 1) {
		throw new Error(
			`Invalid thread key '${threadKey}'. Expected '<channel>:<ts>' (e.g. 'C_TEST:1701234567.000100').`,
		);
	}
	return {
		channel: threadKey.slice(0, idx),
		threadTs: threadKey.slice(idx + 1),
	};
}

export function createPromptChatThreadCommand(): Command {
	const cmd = new Command("prompt-chat-thread");

	cmd
		.description(
			"Send an additional message to an existing chat thread (mid-flight prompt)",
		)
		.requiredOption(
			"-k, --thread-key <key>",
			"Thread key (e.g. 'C_TEST:1234567890.000') from start-chat-session or list-chat-threads",
		)
		.requiredOption("-t, --text <text>", "Message text to send")
		.option(
			"-u, --user <id>",
			"Slack user ID (default: U_F1_USER)",
			"U_F1_USER",
		)
		.action(
			async (options: { threadKey: string; text: string; user: string }) => {
				try {
					const { channel, threadTs } = splitThreadKey(options.threadKey);
					const url = getUrl();
					console.error(gray(`POST ${url}`));
					const response = await fetch(url, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							channel,
							user: options.user,
							text: options.text,
							threadTs,
						}),
					});
					if (!response.ok) {
						throw new Error(`HTTP ${response.status}: ${response.statusText}`);
					}
					const data = (await response.json()) as DispatchResponse;
					if (!data.ok) {
						throw new Error(data.error || "Unknown dispatch error");
					}
					console.log(success("Prompt sent"));
					if (data.eventId) {
						console.log(`  ${formatKeyValue("Event ID", data.eventId)}`);
					}
					if (data.threadKey) {
						console.log(`  ${formatKeyValue("Thread Key", data.threadKey)}`);
					}
				} catch (err) {
					if (err instanceof Error) {
						console.error(
							error(`Failed to prompt chat thread: ${err.message}`),
						);
						process.exit(1);
					}
					throw err;
				}
			},
		);

	return cmd;
}
