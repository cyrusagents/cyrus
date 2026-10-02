import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import {
	type AutomationAuthority,
	digest,
} from "../src/automations/contract.js";
import { ScopedAutomationMcpClient } from "../src/automations/ScopedMcpClient.js";

it("uses supervisor-only immutable publication metadata through real SDK sessions and denies scope widening", async () => {
	const assignmentId = randomUUID();
	const scope = `engineering:${assignmentId}`;
	const files = { "sum.cjs": "exports.sum=(a,b)=>a+b;" };
	const authority: AutomationAuthority = {
		contractVersion: 1,
		definition: {
			id: assignmentId,
			workspaceId: "workspace",
			ownerId: "operator",
			namespace: scope,
			scopeRef: scope,
			revision: 1,
			state: "enabled",
			role: "engineering",
			instruction: "Reviewed fix",
			schedule: null,
			target: { harness: "codex", model: "gpt-5.5" },
			grants: [],
			session: {
				id: `assignment:${assignmentId}`,
				scopeRef: scope,
				role: "engineering",
			},
		},
		engineering: {
			assignmentId,
			repository: "fixture/calculator",
			baseSha: "a".repeat(40),
			headBranch: "reviewed-fix",
			reviewId: randomUUID(),
			generation: 1,
			revision: 1,
			operations: ["execute", "publish"],
			environment: "isolated",
			deployment: "deny",
			technicalBrief: "Repair addition",
			syntheticReproduction: "sum(2,3) must equal 5",
			allowedPaths: ["sum.cjs"],
			files,
		},
		occurrenceId: "occurrence",
		attemptId: "attempt",
		fence: 1,
		leaseUntil: new Date(Date.now() + 90000).toISOString(),
		phase: "execute",
		input: "Reviewed fix",
	};
	let credential = {
		grantId: "stable-engineering-grant",
		audience: "/mcp" as const,
		expiresAt: new Date(Date.now() + 60000).toISOString(),
		token: "synthetic-first-token",
	};
	let revoked = false;
	let extraTool = "";
	const receiptId = randomUUID();
	const published = {
		assignmentId,
		status: "published",
		receiptId,
		publication: {
			repository: "fixture/calculator",
			number: 1,
			url: "https://github.com/fixture/calculator/pull/1",
			headSha: "b".repeat(40),
		},
	};
	let response: Record<string, unknown> = {
		assignmentId,
		status: "uncertain",
		receiptId,
	};
	const requests: { args: unknown; meta: unknown }[] = [];
	const receipts = new Map<string, string>();
	const sessions = new Map<
		string,
		{
			server: McpServer;
			transport: StreamableHTTPServerTransport;
			token: string;
		}
	>();
	const app = Fastify({ forceCloseConnections: true });
	app.all("/mcp", async (request, reply) => {
		if (request.method === "GET") return reply.code(405).send();
		const token = request.headers.authorization?.replace(/^Bearer /, "");
		if (revoked || token !== credential.token) return reply.code(401).send();
		const id = request.headers["mcp-session-id"] as string | undefined;
		let session = id ? sessions.get(id) : undefined;
		if (id && (!session || session.token !== token))
			return reply.code(403).send();
		if (!session) {
			if ((request.body as { method: string }).method !== "initialize")
				return reply.code(403).send();
			const server = new McpServer({
				name: "engineering-fixture",
				version: "1",
			});
			const transport = new StreamableHTTPServerTransport({
				sessionIdGenerator: randomUUID,
				enableJsonResponse: true,
				onsessioninitialized: (id) => sessions.set(id, session!),
			});
			session = { server, transport, token: token! };
			server.registerTool(
				"publish_artifact",
				{
					inputSchema: z
						.object({ title: z.string(), summary: z.string() })
						.strict(),
				},
				async (args, extra) => {
					requests.push({ args, meta: extra._meta });
					const key = extra._meta?.idempotencyKey as string;
					const payload = digest([args, extra._meta?.engineeringFiles]);
					if (receipts.has(key)) expect(receipts.get(key)).toBe(payload);
					else receipts.set(key, payload);
					return { content: [], structuredContent: response };
				},
			);
			if (extraTool)
				server.registerTool(
					extraTool,
					{ inputSchema: z.object({}).strict() },
					async () => ({ content: [] }),
				);
			await server.connect(transport);
		}
		reply.hijack();
		await session.transport.handleRequest(request.raw, reply.raw, request.body);
	});
	const origin = await app.listen({ host: "127.0.0.1", port: 0 });
	const realFetch = globalThis.fetch;
	vi.stubGlobal("fetch", (url: URL | string, init?: RequestInit) => {
		if (String(url) !== "https://engineering.fixture/mcp")
			throw Error("External request denied");
		return realFetch(`${origin}/mcp`, init);
	});
	const controller = new AbortController();
	const client = new ScopedAutomationMcpClient(
		"https://engineering.fixture",
		() => authority,
		() => credential,
		controller.signal,
	);
	const call = {
		name: "publish_artifact" as const,
		arguments: { title: "Repair addition", summary: "Synthetic tests pass" },
	};
	const key = digest([call, files]);
	const publish = () => client.call(call, key, controller.signal, files);
	try {
		for (const args of [
			{ ...call.arguments, assignmentId: randomUUID() },
			{ ...call.arguments, engineeringFiles: files },
			{ ...call.arguments, grantId: "foreign" },
		])
			await expect(
				client.call(
					{ ...call, arguments: args },
					key,
					controller.signal,
					files,
				),
			).rejects.toThrow();
		await expect(client.call(call, key, controller.signal)).rejects.toThrow();
		await expect(
			client.call(call, key, controller.signal, {
				"private.txt": "unreviewed",
			}),
		).rejects.toThrow();
		await expect(
			client.call(
				{ name: "execute", arguments: { command: "node --test" } },
				key,
				controller.signal,
			),
		).rejects.toThrow("local isolated executor");
		expect(sessions.size).toBe(0);
		await expect(publish()).rejects.toThrow("interrupted");
		await client.renew(async () => {
			credential = { ...credential, token: "synthetic-rotated-token" };
		});
		response = published;
		const expected = {
			items: [
				{
					text: JSON.stringify({
						status: "published",
						receiptId,
						publication: published.publication,
					}),
				},
			],
			nextCursor: null,
		};
		await expect(publish()).resolves.toEqual(expected);
		expect(requests).toEqual(
			[0, 1].map(() => ({
				args: call.arguments,
				meta: { idempotencyKey: key, engineeringFiles: files },
			})),
		);
		expect(receipts.size).toBe(1);
		expect(sessions.size).toBe(2);
		await client.close();
		for (const name of ["get_issue", "execute"]) {
			extraTool = name;
			await expect(publish()).rejects.toThrow("interrupted");
		}
		expect(requests).toHaveLength(2);
		extraTool = "";
		for (const forged of [
			{ ...published, assignmentId: randomUUID() },
			{ ...published, customerId: "private" },
			{
				...published,
				publication: { ...published.publication, repository: "foreign/repo" },
			},
			{
				...published,
				publication: {
					...published.publication,
					url: `${published.publication.url}?token=forged`,
				},
			},
			{
				...published,
				publication: { ...published.publication, headSha: "wrong" },
			},
		]) {
			response = forged;
			await expect(publish()).rejects.toThrow("interrupted");
		}
		response = published;
		await expect(publish()).resolves.toEqual(expected);
		const beforeRevocation = requests.length;
		revoked = true;
		await expect(publish()).rejects.toThrow("interrupted");
		expect(requests).toHaveLength(beforeRevocation);
		expect(receipts.size).toBe(1);
	} finally {
		controller.abort();
		await client.close();
		for (const session of sessions.values()) await session.server.close();
		await app.close();
		vi.unstubAllGlobals();
	}
});
