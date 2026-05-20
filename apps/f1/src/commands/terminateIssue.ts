/**
 * Terminate Issue command - move an issue to a terminal state (completed /
 * canceled / deleted) and emit an IssueStateChangeMessage on the unified
 * message bus, so EdgeWorker runs its terminal-state cleanup (stops sessions,
 * runs cyrus-teardown.sh in each repo's worktree, removes worktrees).
 */

import { Command } from "commander";
import { cyan, error, success } from "../utils/colors.js";
import { printRpcUrl, rpcCall } from "../utils/rpc.js";

type TerminalAction = "completed" | "canceled" | "deleted";

interface TerminateIssueParams {
	issueId: string;
	action: TerminalAction;
}

interface TerminateIssueResult {
	success: boolean;
	issueId: string;
	identifier: string;
	action: TerminalAction;
}

export function createTerminateIssueCommand(): Command {
	const cmd = new Command("terminate-issue");

	cmd
		.description(
			"Terminate an issue (completed / canceled / deleted). Triggers EdgeWorker terminal-state cleanup including cyrus-teardown.sh.",
		)
		.requiredOption("-i, --issue-id <id>", "Issue ID to terminate")
		.option(
			"-a, --action <action>",
			"Terminal action: completed | canceled | deleted",
			"completed",
		)
		.action(async (options: { issueId: string; action: string }) => {
			printRpcUrl();

			const action = options.action as TerminalAction;
			if (
				action !== "completed" &&
				action !== "canceled" &&
				action !== "deleted"
			) {
				console.error(
					error(
						`Invalid --action: ${options.action}. Must be one of: completed, canceled, deleted`,
					),
				);
				process.exit(1);
			}

			const params: TerminateIssueParams = {
				issueId: options.issueId,
				action,
			};

			try {
				const result = await rpcCall<TerminateIssueResult>(
					"terminateIssue",
					params,
				);

				console.log(success(`Issue ${result.identifier} terminated`));
				console.log(`  ${cyan("Issue ID")}:    ${result.issueId}`);
				console.log(`  ${cyan("Identifier")}: ${result.identifier}`);
				console.log(`  ${cyan("Action")}:     ${result.action}`);
			} catch (err) {
				if (err instanceof Error) {
					console.error(error(`Failed to terminate issue: ${err.message}`));
					console.error("  Please check that:");
					console.error("    - The issue ID exists");
					console.error(
						"    - The action is one of: completed, canceled, deleted",
					);
					console.error("    - The F1 server is running");
					process.exit(1);
				}
				throw err;
			}
		});

	return cmd;
}
