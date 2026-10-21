import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { handleTestMcp } from "../../src/handlers/testMcp.js";

const servers: Server[] = [];

async function listen(handler: RequestListener): Promise<string> {
	const server = createServer(handler);
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve, reject) => {
					server.close((error) => (error ? reject(error) : resolve()));
					server.closeAllConnections();
				}),
		),
	);
});

describe("MCP HTTP discovery redirect policy", () => {
	it.each([
		"/mcp",
		"/redirect",
	])("discovers tools through %s on the same origin", async (path) => {
		const url = await listen(async (request, response) => {
			if (request.url === "/redirect") {
				response.writeHead(307, { location: "/mcp" }).end();
				return;
			}
			if (request.method !== "POST") {
				response.writeHead(405).end();
				return;
			}
			let body = "";
			for await (const chunk of request) body += chunk;
			const message = JSON.parse(body);
			if (message.id === undefined) {
				response.writeHead(202).end();
				return;
			}
			const result =
				message.method === "initialize"
					? {
							protocolVersion: message.params.protocolVersion,
							capabilities: { tools: {} },
							serverInfo: { name: "redirect-fixture", version: "1" },
						}
					: {
							tools: [{ name: "fixture", inputSchema: { type: "object" } }],
						};
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
		});
		const result = await handleTestMcp({
			transportType: "http",
			serverUrl: `${url}${path}`,
		});
		expect(result.success).toBe(true);
		expect(result.data).toEqual({
			tools: [{ name: "fixture", description: "" }],
			serverInfo: {
				name: "redirect-fixture",
				version: "1",
				protocol: "mcp/1.0",
			},
		});
	});

	it("rejects cross-origin redirects before sending credentials or bodies", async () => {
		let received = 0;
		const destination = await listen((_request, response) => {
			received++;
			response.writeHead(500).end();
		});
		const source = await listen((_request, response) => {
			response.writeHead(307, { location: destination }).end();
		});
		const result = await handleTestMcp({
			transportType: "http",
			serverUrl: source,
			headers: [{ name: "X-API-Key", value: "fixture-secret" }],
		});
		expect(result.success).toBe(false);
		expect(received).toBe(0);
	});
});
