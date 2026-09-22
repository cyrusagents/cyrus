import { type LinearClient, PaginationOrderBy } from "@linear/sdk";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/** Read the conversation recorded in Linear, independently of local runner state. */
export function registerGetAgentSessionContentsTool(
	server: McpServer,
	linearClient: LinearClient,
): void {
	server.registerTool(
		"get_agent_session_contents",
		{
			description:
				"Read a Linear agent session's contents: status, summary, plan, and a page of activities including user prompts, thoughts, actions/tool results, responses, and errors. Uses the Linear API, so the session need not be running locally. Activities retain Linear's createdAt ordering. To read the full session, pass pageInfo.endCursor as after while pageInfo.hasNextPage is true. For metadata and related issue/user details only, use linear_get_agent_session.",
			inputSchema: {
				sessionId: z.string().min(1).describe("Linear agent session ID (UUID)"),
				first: z
					.number()
					.int()
					.min(1)
					.max(250)
					.default(50)
					.describe("Maximum activities to return (default 50, maximum 250)"),
				after: z
					.string()
					.min(1)
					.optional()
					.describe("Activity cursor from the preceding pageInfo.endCursor"),
			},
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				openWorldHint: true,
			},
		},
		async ({ sessionId, first, after }) => {
			try {
				const session = await linearClient.agentSession(sessionId);
				if (!session) {
					throw new Error(`Agent session ${sessionId} not found`);
				}

				const connection = await session.activities({
					first,
					after,
					orderBy: PaginationOrderBy.CreatedAt,
				});
				const activities = connection.nodes.map((activity) => ({
					id: activity.id,
					createdAt: activity.createdAt.toISOString(),
					updatedAt: activity.updatedAt.toISOString(),
					userId: activity.userId ?? null,
					sourceCommentId: activity.sourceCommentId ?? null,
					content: activity.content,
					signal: activity.signal ?? null,
					signalMetadata: activity.signalMetadata ?? null,
					ephemeral: activity.ephemeral,
				}));

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								success: true,
								session: {
									id: session.id,
									status: session.status,
									createdAt: session.createdAt.toISOString(),
									updatedAt: session.updatedAt.toISOString(),
									startedAt: session.startedAt?.toISOString() ?? null,
									endedAt: session.endedAt?.toISOString() ?? null,
									issueId: session.issueId ?? null,
									commentId: session.commentId ?? null,
									summary: session.summary ?? null,
									plan: session.plan ?? null,
								},
								activities,
								count: activities.length,
								pageInfo: {
									hasNextPage: connection.pageInfo.hasNextPage,
									hasPreviousPage: connection.pageInfo.hasPreviousPage,
									startCursor: connection.pageInfo.startCursor ?? null,
									endCursor: connection.pageInfo.endCursor ?? null,
								},
							}),
						},
					],
				};
			} catch (error) {
				return {
					isError: true,
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								success: false,
								error: error instanceof Error ? error.message : String(error),
							}),
						},
					],
				};
			}
		},
	);
}
