/**
 * Start Session command - Start an agent session on an issue
 */

import { Command } from "commander";
import { error, success } from "../utils/colors.js";
import { formatKeyValue } from "../utils/output.js";
import { printRpcUrl, rpcCall } from "../utils/rpc.js";

interface Session {
	sessionId: string;
	issueId: string;
	status: string;
	createdAt: number;
	updatedAt: number;
}

interface StartSessionResult {
	session: Session;
}

interface StartSessionParams {
	issueId: string;
	asUserId?: string;
}

export function createStartSessionCommand(): Command {
	const cmd = new Command("start-session");

	cmd
		.description("Start an agent session on an issue")
		.requiredOption("-i, --issue-id <id>", "Issue ID to start session on")
		.option(
			"-u, --as-user <userId>",
			"Act as this user (see create-user) — becomes the session creator/prompter",
		)
		.action(async (options: { issueId: string; asUser?: string }) => {
			printRpcUrl();

			const params: StartSessionParams = {
				issueId: options.issueId,
				...(options.asUser && { asUserId: options.asUser }),
			};

			try {
				const result = await rpcCall<StartSessionResult>(
					"startSession",
					params,
				);

				console.log(success("Session started successfully"));
				console.log(
					`  ${formatKeyValue("Session ID", result.session.sessionId)}`,
				);
				console.log(`  ${formatKeyValue("Issue ID", result.session.issueId)}`);
				console.log(`  ${formatKeyValue("Status", result.session.status)}`);
				console.log(
					`  ${formatKeyValue("Created At", new Date(result.session.createdAt).toISOString())}`,
				);
			} catch (err) {
				if (err instanceof Error) {
					console.error(error(`Failed to start session: ${err.message}`));
					console.error("  Please check that:");
					console.error("    - The issue ID exists");
					console.error(
						"    - There isn't already an active session on this issue",
					);
					console.error("    - The F1 server is running");
					process.exit(1);
				}
				throw err;
			}
		});

	return cmd;
}
