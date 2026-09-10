/** Run while cypack-1506-server.mjs is serving F1 session-1. */
import assert from "node:assert/strict";
import { Client } from "../../../../packages/mcp-tools/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StreamableHTTPClientTransport } from "../../../../packages/mcp-tools/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js";

const client = new Client({
	name: "f1-session-contents-check",
	version: "1.0.0",
});
await client.connect(
	new StreamableHTTPClientTransport(
		new URL("http://localhost:3600/mcp/cyrus-tools"),
		{
			requestInit: {
				headers: {
					"x-cyrus-mcp-context-id": "f1-test-repo:session-1",
					...(process.env.CYRUS_API_KEY
						? { Authorization: `Bearer ${process.env.CYRUS_API_KEY}` }
						: {}),
				},
			},
		},
	),
);
try {
	const { tools } = await client.listTools();
	assert(tools.some((tool) => tool.name === "get_agent_session_contents"));
	assert(tools.some((tool) => tool.name === "linear_get_agent_session"));
	const call = async (args) =>
		client.callTool({ name: "get_agent_session_contents", arguments: args });
	const decode = (result) => JSON.parse(result.content[0].text);
	const first = decode(await call({ sessionId: "session-1", first: 2 }));
	assert(first.success);
	assert.equal(first.count, 2);
	assert(first.activities.every((a) => a.content.type && a.createdAt));
	assert(first.pageInfo.hasNextPage);
	const second = decode(
		await call({
			sessionId: "session-1",
			first: 2,
			after: first.pageInfo.endCursor,
		}),
	);
	assert(second.success);
	assert.equal(second.count, 2);
	assert(
		second.activities.every(
			(a) => !first.activities.some((b) => a.id === b.id),
		),
	);
	const missing = await call({ sessionId: "missing-session" });
	assert(missing.isError);
	assert.equal(decode(missing).success, false);
	const invalid = await call({ sessionId: "session-1", first: 251 });
	assert(invalid.isError);
	console.log(
		JSON.stringify(
			{
				result: "PASS",
				firstPage: first.activities.map((a) => a.id),
				secondPage: second.activities.map((a) => a.id),
				missingSession: decode(missing),
				invalidPageSizeRejected: true,
			},
			null,
			2,
		),
	);
} finally {
	await client.close();
}
