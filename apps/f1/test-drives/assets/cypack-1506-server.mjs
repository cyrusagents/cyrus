/**
 * F1-only bridge: exercise the real Linear SDK over HTTP against live F1 state.
 * Run from the repo root after pnpm build:
 * CYRUS_PORT=3600 CYRUS_REPO_PATH=/tmp/f1-cypack-1506 bun run apps/f1/test-drives/assets/cypack-1506-server.mjs
 * No production Linear requests or mutations are made by this bridge.
 */

import { CLIIssueTrackerService } from "../../../../packages/core/dist/index.js";
import { LinearClient } from "../../../../packages/mcp-tools/node_modules/@linear/sdk/dist/index-cjs.js";

let tracker;
const api = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(req) {
		const { query, variables } = await req.json();
		const state = tracker?.getState();
		const session = state?.agentSessions.get(variables.id);
		console.log(
			"[F1 Linear API]",
			query.match(/query\s+(\w+)/)?.[1],
			JSON.stringify(variables),
		);
		if (!session)
			return Response.json({
				errors: [{ message: "Agent session not found" }],
			});
		if (/query\s+agentSession_activities\b/i.test(query)) {
			const all = [...state.agentActivities.values()]
				.filter((a) => a.agentSessionId === session.id)
				.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
			const offset = variables.after
				? all.findIndex((a) => a.id === variables.after) + 1
				: 0;
			const page = all.slice(offset, offset + variables.first);
			const nodes = page.map((a) => ({
				id: a.id,
				createdAt: a.createdAt,
				updatedAt: a.createdAt,
				content: {
					...(a.type === "action"
						? JSON.parse(a.content)
						: { type: a.type, body: a.content }),
					__typename: `AgentActivity${a.type[0].toUpperCase()}${a.type.slice(1)}Content`,
				},
				ephemeral: a.ephemeral ?? false,
				signal: a.signal ?? null,
				user: { id: "user-default" },
				agentSession: { id: session.id },
			}));
			return Response.json({
				data: {
					agentSession: {
						activities: {
							nodes,
							pageInfo: {
								hasNextPage: offset + page.length < all.length,
								hasPreviousPage: offset > 0,
								startCursor: page[0]?.id ?? null,
								endCursor: page.at(-1)?.id ?? null,
							},
						},
					},
				},
			});
		}
		if (/query\s+agentSession\b/i.test(query))
			return Response.json({
				data: {
					agentSession: {
						...session,
						issue: { id: session.issueId },
						comment: { id: session.commentId },
					},
				},
			});
		return Response.json({
			errors: [{ message: "Unsupported F1 fixture query" }],
		});
	},
});
const linear = new LinearClient({
	apiKey: "f1-test-only",
	apiUrl: `http://127.0.0.1:${api.port}/graphql`,
});
// F1 normally omits cyrus-tools because its tracker has no Linear client.
// This test-only method enables the production McpConfigService wiring.
CLIIssueTrackerService.prototype.getClient = function () {
	tracker = this;
	return linear;
};
await import("../../server.ts");
