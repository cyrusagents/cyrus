/** Isolated F1 transport drive: actual EdgeWorker MCP registration and publisher.
 * Hosted callback below is a receipt fixture, not a real dot/Work receiver.
 * Run after pnpm build: bun apps/f1/inbox-publication-drive.mjs
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LinearClient } from "@linear/sdk";

const fromMcpTools = createRequire(
	new URL("../../packages/mcp-tools/package.json", import.meta.url),
);
const { Client } = await import(
	fromMcpTools.resolve("@modelcontextprotocol/sdk/client/index.js")
);
const { StreamableHTTPClientTransport } = await import(
	fromMcpTools.resolve("@modelcontextprotocol/sdk/client/streamableHttp.js")
);

import { EdgeWorker } from "cyrus-edge-worker";

const home = await mkdtemp(join(tmpdir(), "cyrus-inbox-f1-"));
const calls = [];
const receipt = {
	messageId: "a2345678-1234-4234-8234-123456789abc",
	status: "queued",
};
const control = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		assert.equal(new URL(request.url).pathname, "/api/codex-inbox/messages");
		assert.equal(
			request.headers.get("authorization"),
			"Bearer f1-inbox-runtime-key",
		);
		calls.push(await request.json());
		return Response.json(receipt, { status: 202 });
	},
});
const before = {
	url: process.env.CYRUS_APP_URL,
	key: process.env.CYRUS_API_KEY,
	team: process.env.CYRUS_TEAM_ID,
};
process.env.CYRUS_APP_URL = `http://127.0.0.1:${control.port}`;
process.env.CYRUS_API_KEY = "f1-inbox-runtime-key";
delete process.env.CYRUS_TEAM_ID;
let worker, client;
try {
	worker = new EdgeWorker({
		platform: "cli",
		repositories: [],
		cyrusHome: home,
		serverPort: 0,
		serverHost: "127.0.0.1",
	});
	// The stock CLI F1 tracker intentionally has no Linear SDK. Supply its inert
	// SDK boundary so this drive exercises the actual Linear-enabled MCP path.
	worker.mcpConfigService.deps.getLinearTokenForWorkspace = () =>
		"f1-linear-no-network";
	worker.mcpConfigService.deps.getIssueTracker = () => ({
		getClient: () => new LinearClient({ apiKey: "f1-linear-no-network" }),
	});
	await worker.registerCyrusToolsMcpEndpoint();
	const fastify = worker.getSharedApplicationServer().getFastifyInstance();
	await fastify.listen({ host: "127.0.0.1", port: 0 });
	const address = fastify.server.address();
	const config = worker.mcpConfigService.buildMcpConfig(
		"f1-repository",
		"f1-workspace",
		"f1-session",
	)["cyrus-tools"];
	client = new Client({ name: "f1-inbox", version: "1" });
	await client.connect(
		new StreamableHTTPClientTransport(
			new URL(`http://127.0.0.1:${address.port}/mcp/cyrus-tools`),
			{ requestInit: { headers: config.headers } },
		),
	);
	assert.ok(
		(await client.listTools()).tools.some(
			(t) => t.name === "post_message_to_codex",
		),
	);
	const args = {
		inboxId: "b2345678-1234-4234-8234-123456789abc",
		idempotencyKey: "f1-message-1",
		text: "F1 inert message",
	};
	for (let i = 0; i < 2; i++) {
		const result = await client.callTool({
			name: "post_message_to_codex",
			arguments: args,
		});
		assert.deepEqual(JSON.parse(result.content[0].text), receipt);
	}
	assert.equal(calls.length, 2);
	assert.deepEqual(calls[0], calls[1]);
	const unauth = await fetch(
		`http://127.0.0.1:${address.port}/mcp/cyrus-tools`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
		},
	);
	assert.equal(unauth.status, 401);
	console.log(
		JSON.stringify({
			result: "PASS",
			actual: "EdgeWorker MCP context/auth/catalog and publisher HTTP",
			receipt: receipt.status,
			duplicatePayloadsEqual: true,
			receiver: "fixture; no model execution claimed",
		}),
	);
} finally {
	await client?.close();
	await worker?.getSharedApplicationServer().getFastifyInstance().close();
	control.stop(true);
	for (const [key, value] of Object.entries({
		CYRUS_APP_URL: before.url,
		CYRUS_API_KEY: before.key,
		CYRUS_TEAM_ID: before.team,
	})) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	await rm(home, { recursive: true, force: true });
}
