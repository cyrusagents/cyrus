import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import {
	createCodexMessagePublisher,
	registerPostMessageToCodexTool,
} from "./post-message-to-codex.js";

const input = {
	inboxId: "124a5678-1234-4234-8234-123456789abc",
	idempotencyKey: "operation-1",
	text: "test message",
};
const receipt = {
	messageId: "234a5678-1234-4234-8234-123456789abc",
	status: "queued",
};
describe("authorized inbox publisher", () => {
	it("uses fixed control plane, preserves idempotency and exposes honest receipt through actual MCP", async () => {
		const requests: Request[] = [];
		const fetcher = vi.fn(
			async (url: URL | RequestInfo, init?: RequestInit) => {
				requests.push(new Request(url, init));
				return Response.json(receipt, { status: 202 });
			},
		);
		const publisher = createCodexMessagePublisher(
			{ baseUrl: "https://cyrus.example", apiKey: "test-only-key" },
			fetcher as typeof fetch,
		);
		const server = new McpServer({ name: "test", version: "1" });
		registerPostMessageToCodexTool(server, publisher);
		const client = new Client({ name: "test", version: "1" });
		const [a, b] = InMemoryTransport.createLinkedPair();
		await server.connect(a);
		await client.connect(b);
		try {
			const first = await client.callTool({
				name: "post_message_to_codex",
				arguments: input,
			});
			expect(first).toMatchObject({
				content: [{ type: "text", text: JSON.stringify(receipt) }],
			});
			await client.callTool({
				name: "post_message_to_codex",
				arguments: input,
			});
			expect(requests).toHaveLength(2);
			expect(requests[0].url).toBe(
				"https://cyrus.example/api/codex-inbox/messages",
			);
			expect(requests[0].redirect).toBe("error");
			expect(await requests[0].json()).toEqual(await requests[1].json());
			const rejected = await client.callTool({
				name: "post_message_to_codex",
				arguments: { ...input, callback: "https://evil.example" },
			});
			expect(rejected.isError).toBe(true);
			expect(requests).toHaveLength(2);
		} finally {
			await client.close();
			await server.close();
		}
	});
	it("rejects forged receipts and redacts backend failures", async () => {
		const publish = createCodexMessagePublisher(
			{ baseUrl: "https://cyrus.example", apiKey: "secret" },
			vi.fn(async () => Response.json({ status: "delivered" })) as typeof fetch,
		);
		await expect(publish(input)).rejects.toThrow();
		const fail = createCodexMessagePublisher(
			{ baseUrl: "https://cyrus.example", apiKey: "secret" },
			vi.fn(
				async () => new Response("secret upstream body", { status: 403 }),
			) as typeof fetch,
		);
		await expect(fail(input)).rejects.toThrow("403");
	});
});
