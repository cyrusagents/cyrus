/**
 * Prompt Session command - Send a message to an active session
 */

import { Command } from "commander";
import { error, success } from "../utils/colors.js";
import { printRpcUrl, rpcCall } from "../utils/rpc.js";

interface PromptSessionResult {
	success: boolean;
	message: string;
}

interface PromptSessionParams {
	sessionId: string;
	message: string;
	asUserId?: string;
}

export function createPromptSessionCommand(): Command {
	const cmd = new Command("prompt-session");

	cmd
		.description("Send a message to an active session")
		.requiredOption("-s, --session-id <id>", "Session ID to send message to")
		.requiredOption("-m, --message <text>", "Message to send")
		.option(
			"-u, --as-user <userId>",
			"Send the prompt as this user (see create-user) — may differ from the session creator",
		)
		.action(
			async (options: {
				sessionId: string;
				message: string;
				asUser?: string;
			}) => {
				printRpcUrl();

				const params: PromptSessionParams = {
					sessionId: options.sessionId,
					message: options.message,
					...(options.asUser && { asUserId: options.asUser }),
				};

				try {
					const result = await rpcCall<PromptSessionResult>(
						"promptSession",
						params,
					);

					console.log(success("Message sent successfully"));
					console.log(`  ${result.message}`);
				} catch (err) {
					if (err instanceof Error) {
						console.error(error(`Failed to send message: ${err.message}`));
						console.error("  Please check that:");
						console.error("    - The session ID exists");
						console.error("    - The session is still active");
						console.error("    - The message is not empty");
						console.error("    - The F1 server is running");
						process.exit(1);
					}
					throw err;
				}
			},
		);

	return cmd;
}
