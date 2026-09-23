/**
 * Create Comment command - Add a comment to an issue
 */

import { Command } from "commander";
import { error, success } from "../utils/colors.js";
import { formatKeyValue } from "../utils/output.js";
import { printRpcUrl, rpcCall } from "../utils/rpc.js";

interface Comment {
	id: string;
	body: string;
	createdAt: Date;
	updatedAt: Date;
}

interface CreateCommentResult {
	comment: Comment;
}

interface CreateCommentParams {
	issueId: string;
	body: string;
	mentionAgent?: boolean;
	asUserId?: string;
}

export function createCreateCommentCommand(): Command {
	const cmd = new Command("create-comment");

	cmd
		.description("Create a comment on an issue")
		.requiredOption("-i, --issue-id <id>", "Issue ID to comment on")
		.requiredOption("-b, --body <text>", "Comment body text")
		.option("-m, --mention-agent", "Mention the agent in the comment", false)
		.option(
			"-u, --as-user <userId>",
			"Author the comment as this user (see create-user)",
		)
		.action(
			async (options: {
				issueId: string;
				body: string;
				mentionAgent: boolean;
				asUser?: string;
			}) => {
				printRpcUrl();

				const params: CreateCommentParams = {
					issueId: options.issueId,
					body: options.body,
					mentionAgent: options.mentionAgent,
					...(options.asUser && { asUserId: options.asUser }),
				};

				try {
					const result = await rpcCall<CreateCommentResult>(
						"createComment",
						params,
					);

					console.log(success("Comment created successfully"));
					console.log(`  ${formatKeyValue("Comment ID", result.comment.id)}`);
					console.log(
						`  ${formatKeyValue("Body", result.comment.body.slice(0, 60) + (result.comment.body.length > 60 ? "..." : ""))}`,
					);
					console.log(
						`  ${formatKeyValue("Created", new Date(result.comment.createdAt).toISOString())}`,
					);
					if (options.mentionAgent) {
						console.log("  Agent was mentioned in the comment");
					}
				} catch (err) {
					if (err instanceof Error) {
						console.error(error(`Failed to create comment: ${err.message}`));
						console.error("  Please check that:");
						console.error("    - The issue ID exists");
						console.error("    - The comment body is not empty");
						console.error("    - The F1 server is running");
						process.exit(1);
					}
					throw err;
				}
			},
		);

	return cmd;
}
