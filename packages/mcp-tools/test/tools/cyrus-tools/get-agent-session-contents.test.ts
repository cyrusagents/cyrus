import { LinearClient } from "@linear/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	type MockInstance,
	vi,
} from "vitest";
import { createCyrusToolsServer } from "../../../src/tools/cyrus-tools/index.js";

const sessionId = "16f7f988-4a3b-46d1-8434-d5de6e42791f";
const timestamp = "2026-09-10T15:00:00.000Z";
const contents = [
	{
		__typename: "AgentActivityPromptContent",
		type: "prompt",
		body: "Find the failure",
	},
	{
		__typename: "AgentActivityThoughtContent",
		type: "thought",
		body: "Reading logs",
	},
	{
		__typename: "AgentActivityActionContent",
		type: "action",
		action: "Bash",
		parameter: "pnpm test",
		result: "All tests passed",
	},
	{
		__typename: "AgentActivityElicitationContent",
		type: "elicitation",
		body: "Which branch?",
	},
	{
		__typename: "AgentActivityErrorContent",
		type: "error",
		body: "Connection lost",
	},
	{
		__typename: "AgentActivityResponseContent",
		type: "response",
		body: "Fixed the failure",
	},
];
const session = {
	id: sessionId,
	createdAt: timestamp,
	updatedAt: timestamp,
	status: "complete",
	summary: "Fixed",
	plan: { steps: [{ content: "Inspect", status: "completed" }] },
	issue: { id: "issue-1" },
	comment: { id: "comment-1" },
};
const nodes = contents.map((content, i) => ({
	id: `activity-${i}`,
	createdAt: timestamp,
	updatedAt: timestamp,
	content,
	ephemeral: i === 1,
	signal: i === 3 ? "select" : null,
	signalMetadata: i === 3 ? { options: ["main"] } : null,
	user: { id: "user-1" },
	sourceComment: null,
}));
const pageInfo = {
	hasNextPage: false,
	hasPreviousPage: false,
	startCursor: "cursor-0",
	endCursor: "cursor-5",
};

function parse(result: Awaited<ReturnType<Client["callTool"]>>) {
	const content = result.content as Array<{ type: string; text: string }>;
	return JSON.parse(content[0]!.text);
}

describe("get_agent_session_contents over MCP with the Linear SDK", () => {
	let client: Client;
	let server: ReturnType<typeof createCyrusToolsServer>;
	let request: MockInstance<LinearClient["client"]["request"]>;

	// Linear serializes JSON scalars as strings on the GraphQL wire.
	const respond = (result: { data: unknown }) =>
		request.mockResolvedValueOnce(
			JSON.parse(
				JSON.stringify(result.data, (key, value) =>
					(key === "plan" || key === "signalMetadata") && value
						? JSON.stringify(value)
						: value,
				),
			),
		);

	beforeEach(async () => {
		const linear = new LinearClient({
			apiKey: "test-only",
			apiUrl: "http://linear.invalid/graphql",
		});
		request = vi.spyOn(linear.client, "request");
		respond({ data: { agentSession: session } });
		respond({
			data: { agentSession: { activities: { nodes, pageInfo } } },
		});
		server = createCyrusToolsServer(linear);
		client = new Client({ name: "session-test", version: "1.0.0" });
		const [clientTransport, serverTransport] =
			InMemoryTransport.createLinkedPair();
		await server.connect(serverTransport);
		await client.connect(clientTransport);
	});

	afterEach(async () => {
		await client.close();
		await server.close();
		vi.restoreAllMocks();
	});

	it("exposes a separate read-only tool and retains the metadata tool", async () => {
		const { tools } = await client.listTools();
		expect(tools.some((tool) => tool.name === "get_agent_session")).toBe(false);
		expect(
			tools.find((tool) => tool.name === "get_agent_session_contents")
				?.annotations?.readOnlyHint,
		).toBe(true);
		expect(
			tools.find((tool) => tool.name === "linear_get_agent_session")
				?.inputSchema.properties,
		).toEqual({
			sessionId: {
				type: "string",
				description: "The ID of the agent session to retrieve (UUID)",
			},
		});
	});

	it("returns complete content for every activity type and session metadata", async () => {
		const result = await client.callTool({
			name: "get_agent_session_contents",
			arguments: { sessionId },
		});
		expect(result.isError).not.toBe(true);
		expect(parse(result)).toEqual({
			success: true,
			session: {
				id: sessionId,
				status: "complete",
				createdAt: timestamp,
				updatedAt: timestamp,
				startedAt: null,
				endedAt: null,
				issueId: "issue-1",
				commentId: "comment-1",
				summary: session.summary,
				plan: session.plan,
			},
			activities: nodes.map(
				({ user, sourceComment: _sourceComment, ...node }) => ({
					...node,
					userId: user.id,
					sourceCommentId: null,
				}),
			),
			count: 6,
			pageInfo,
		});
		expect(request.mock.calls[0]?.[1]).toEqual({ id: sessionId });
		expect(request.mock.calls[1]?.[1]).toEqual({
			id: sessionId,
			first: 50,
			orderBy: "createdAt",
		});
	});

	it("forwards cursors and page sizes without fetching unbounded history", async () => {
		request.mockReset();
		respond({ data: { agentSession: session } });
		respond({
			data: {
				agentSession: {
					activities: {
						nodes: [nodes[2]],
						pageInfo: { ...pageInfo, hasNextPage: true, endCursor: "next" },
					},
				},
			},
		});
		const result = parse(
			await client.callTool({
				name: "get_agent_session_contents",
				arguments: { sessionId, first: 1, after: "previous" },
			}),
		);
		expect(request.mock.calls[1]?.[1]).toEqual({
			id: sessionId,
			first: 1,
			after: "previous",
			orderBy: "createdAt",
		});
		expect(request).toHaveBeenCalledTimes(2);
		expect(result.count).toBe(1);
		expect(result.pageInfo).toEqual({
			...pageInfo,
			hasNextPage: true,
			endCursor: "next",
		});
		expect(result.activities[0].content).toEqual(contents[2]);
	});

	it("handles empty sessions and absent optional metadata", async () => {
		request.mockReset();
		respond({
			data: {
				agentSession: {
					id: sessionId,
					createdAt: timestamp,
					updatedAt: timestamp,
					status: "pending",
				},
			},
		});
		respond({
			data: {
				agentSession: {
					activities: {
						nodes: [],
						pageInfo: { hasNextPage: false, hasPreviousPage: false },
					},
				},
			},
		});
		const result = parse(
			await client.callTool({
				name: "get_agent_session_contents",
				arguments: { sessionId },
			}),
		);
		expect(result).toEqual({
			success: true,
			session: {
				id: sessionId,
				status: "pending",
				createdAt: timestamp,
				updatedAt: timestamp,
				startedAt: null,
				endedAt: null,
				issueId: null,
				commentId: null,
				summary: null,
				plan: null,
			},
			activities: [],
			count: 0,
			pageInfo: {
				hasNextPage: false,
				hasPreviousPage: false,
				startCursor: null,
				endCursor: null,
			},
		});
	});

	it.each([
		0,
		-1,
		251,
		1.5,
		"10",
	])("rejects invalid page size %s before contacting Linear", async (first) => {
		const result = await client.callTool({
			name: "get_agent_session_contents",
			arguments: { sessionId, first },
		});
		expect(result.isError).toBe(true);
		expect(request).not.toHaveBeenCalled();
	});

	it.each([
		"session",
		"activities",
	])("reports %s API failures as MCP errors", async (stage) => {
		request.mockReset();
		if (stage === "activities") respond({ data: { agentSession: session } });
		request.mockRejectedValueOnce(new Error("Access denied"));
		const result = await client.callTool({
			name: "get_agent_session_contents",
			arguments: { sessionId },
		});
		expect(result.isError).toBe(true);
		expect(parse(result)).toEqual({ success: false, error: "Access denied" });
	});

	it("reports missing sessions as MCP errors", async () => {
		request.mockReset();
		request.mockRejectedValueOnce(
			new Error(`Agent session ${sessionId} not found`),
		);
		const result = await client.callTool({
			name: "get_agent_session_contents",
			arguments: { sessionId },
		});
		expect(result.isError).toBe(true);
		expect(parse(result)).toEqual({
			success: false,
			error: `Agent session ${sessionId} not found`,
		});
		expect(request).toHaveBeenCalledTimes(1);
	});
});
