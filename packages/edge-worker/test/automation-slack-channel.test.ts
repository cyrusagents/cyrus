import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import {
	type AutomationAuthority,
	admissionSchema,
	authorizeTool,
	type McpCredential,
	permittedToolNames,
	resourceSchema,
	scopedToolResult,
	scopedToolSchemas,
} from "../src/automations/contract.js";
import { ScopedAutomationMcpClient } from "../src/automations/ScopedMcpClient.js";

function authority(): AutomationAuthority {
	return {
		contractVersion: 1,
		definition: {
			id: "automation",
			workspaceId: "workspace",
			ownerId: "operator",
			namespace: "customer-a",
			scopeRef: "binding-a",
			revision: 1,
			state: "enabled",
			role: "coordinator",
			instruction: "Read admitted Slack history",
			schedule: null,
			target: { harness: "codex", model: "fixture" },
			grants: [
				{
					id: "stable-resource-binding",
					connectionId: "connection",
					accountId: "account",
					resource: {
						provider: "slack",
						channelId: "channel-a",
						scope: "channel",
					},
					permissions: ["read", "write", "delegate"],
				},
			],
		},
		occurrenceId: "occurrence",
		attemptId: "attempt",
		fence: 1,
		leaseUntil: new Date(Date.now() + 90000).toISOString(),
		phase: "execute",
		input: "Read history",
	};
}
it("keeps channel schemas read-only, strict and distinct from thread grants", () => {
	const a = authority();
	expect(permittedToolNames(a)).toEqual([
		"read_messages",
		"read_thread",
		"delegate_investigation",
	]);
	expect(
		resourceSchema.safeParse({
			provider: "slack",
			channelId: "channel-a",
			scope: "channel",
			threadTs: "123",
		}).success,
	).toBe(false);
	for (const field of [
		"workspaceId",
		"customerId",
		"accountId",
		"connectionId",
		"channelId",
		"threadTs",
		"issueId",
		"role",
		"runId",
		"grantId",
	])
		expect(() =>
			authorizeTool(a, {
				name: "read_messages",
				arguments: { [field]: "forged" },
			}),
		).toThrow();
	for (const name of [
		"reply",
		"add_comment",
		"list_issues",
		"get_issue",
		"execute",
	])
		expect(() => authorizeTool(a, { name, arguments: {} })).toThrow();
	expect(() =>
		authorizeTool(a, {
			name: "read_thread",
			arguments: { reference: randomUUID(), channelId: "foreign" },
		}),
	).toThrow();
	expect(() =>
		authorizeTool(a, { name: "read_messages", arguments: { limit: 101 } }),
	).toThrow();
	expect(() =>
		authorizeTool(a, {
			name: "read_messages",
			arguments: { cursor: "provider-cursor" },
		}),
	).toThrow();
	expect(() =>
		authorizeTool(a, {
			name: "delegate_investigation",
			arguments: { instruction: "Read", tracking: "assigned_ticket" },
		}),
	).toThrow();
	a.definition.role = "investigator";
	expect(permittedToolNames(a)).toEqual(["read_messages", "read_thread"]);
	a.definition.grants[0]!.resource = {
		provider: "slack",
		channelId: "channel-a",
		threadTs: "123.456",
	};
	expect(permittedToolNames(a)).toEqual(["read_messages"]);
	a.definition.role = "coordinator";
	expect(permittedToolNames(a)).toContain("reply");
	expect(() =>
		authorizeTool(a, {
			name: "read_messages",
			arguments: { cursor: "existing-thread-cursor" },
		}),
	).not.toThrow();
});
it("rejects foreign result metadata and unsupported negotiation values", () => {
	const a = authority(),
		g = a.definition.grants[0]!;
	for (const foreign of [
		{ grantId: "rotating-grant" },
		{ connectionId: "foreign" },
		{ accountId: "foreign" },
		{ resource: { ...g.resource, channelId: "foreign" } },
	])
		expect(() =>
			scopedToolResult(
				a,
				{ name: "read_messages", arguments: {} },
				{
					items: [
						{
							grantId: g.id,
							connectionId: g.connectionId,
							accountId: g.accountId,
							resource: g.resource,
							text: "{}",
							...foreign,
						},
					],
					nextCursor: null,
				},
			),
		).toThrow();
	const admission = {
		authority: a,
		mcp: {
			token: "fixture-token-with-at-least-thirty-two-characters",
			audience: "/mcp",
			grantId: g.id,
			expiresAt: a.leaseUntil,
		},
	};
	expect(
		admissionSchema.safeParse({ ...admission, slackChannelRead: true }).success,
	).toBe(true);
	expect(
		admissionSchema.safeParse({ ...admission, slackChannelRead: false })
			.success,
	).toBe(false);
});

it.each([
	false,
	true,
])("SDK channel references/cursors stay scoped through rotation (continuation=%s)", async (continuation) => {
	const a = authority();
	a.definition.grants[0]!.permissions = ["read"];
	let credential: McpCredential = {
		token: "first-fixture-token-thirty-two-characters",
		grantId: a.definition.grants[0]!.id,
		audience: "/mcp",
		expiresAt: new Date(Date.now() + 60000).toISOString(),
		...(continuation && { sessionRenewal: true }),
	};
	let currentToken = credential.token,
		revoked = false,
		expiredReference = false,
		absent = false,
		malformed = false;
	let deniedRequests = 0;
	let providerCalls = 0,
		initializations = 0;
	const sessions = new Map<
		string,
		{
			server: McpServer;
			transport: StreamableHTTPServerTransport;
			token: string;
			references: Set<string>;
			cursors: Set<string>;
		}
	>();
	const app = Fastify({ forceCloseConnections: true });
	app.all("/mcp", async (request, reply) => {
		if (request.method === "GET") return reply.code(405).send();
		const token = request.headers.authorization?.slice(7),
			id = request.headers["mcp-session-id"] as string | undefined;
		if (revoked || token !== currentToken) {
			deniedRequests++;
			return reply.code(403).send();
		}
		let session = id ? sessions.get(id) : undefined;
		if (id && (!session || session.token !== token))
			return reply.code(403).send();
		const body = request.body as {
			method?: string;
			params?: {
				name?: string;
				arguments?: { reference?: string; cursor?: string };
			};
		};
		if (body?.method === "tools/call" && session) {
			const args = body.params?.arguments;
			if (
				body.params?.name === "read_thread" &&
				(expiredReference || !session.references.has(args?.reference ?? ""))
			) {
				deniedRequests++;
				return reply.code(403).send();
			}
			if (args?.cursor && !session.cursors.has(args.cursor))
				return reply.code(403).send();
		}
		if (!session) {
			if (body?.method !== "initialize") return reply.code(403).send();
			initializations++;
			const server = new McpServer({
				name: "scoped-slack-fixture",
				version: "1",
			});
			const transport = new StreamableHTTPServerTransport({
				sessionIdGenerator: randomUUID,
				enableJsonResponse: true,
				onsessioninitialized: (id) => sessions.set(id, session!),
			});
			session = {
				server,
				transport,
				token: token!,
				references: new Set(),
				cursors: new Set(),
			};
			const bound = session;
			for (const schema of scopedToolSchemas(a)) {
				if (absent && schema.shape.name.value === "read_thread") continue;
				const name = schema.shape.name.value;
				server.registerTool(
					name,
					{ inputSchema: schema.shape.arguments },
					async () => {
						providerCalls++;
						const reference = randomUUID(),
							cursor = randomUUID();
						bound.references.add(reference);
						bound.cursors.add(cursor);
						const g = a.definition.grants[0]!;
						return {
							content: [],
							structuredContent: {
								items: [
									{
										grantId: g.id,
										connectionId: g.connectionId,
										accountId: g.accountId,
										resource: g.resource,
										text:
											name === "read_messages"
												? JSON.stringify({
														messages: [
															{
																reference,
																text: "Admitted channel root",
																...(malformed && { channelId: "forged" }),
															},
														],
													})
												: "Admitted thread replies",
									},
								],
								nextCursor: name === "read_messages" ? cursor : null,
							},
						};
					},
				);
			}
			await server.connect(transport);
		}
		reply.hijack();
		await session.transport.handleRequest(request.raw, reply.raw, request.body);
	});
	const origin = await app.listen({ host: "127.0.0.1", port: 0 });
	const fetch = globalThis.fetch;
	vi.stubGlobal("fetch", (url: string | URL, init?: RequestInit) => {
		if (String(url) !== "https://slack.fixture/mcp")
			throw Error("External network denied");
		return fetch(`${origin}/mcp`, init);
	});
	const stop = new AbortController();
	const client = new ScopedAutomationMcpClient(
		"https://slack.fixture",
		() => a,
		() => credential,
		stop.signal,
	);
	const call = (
		name: "read_messages" | "read_thread",
		args: Record<string, unknown> = {},
	) =>
		client.call({ name, arguments: args } as never, randomUUID(), stop.signal);
	const history = async () => {
		const result = await call("read_messages");
		return {
			reference: JSON.parse(result.items[0]!.text).messages[0]
				.reference as string,
			cursor: result.nextCursor!,
		};
	};
	try {
		let issued = await history();
		await call("read_thread", { reference: issued.reference });
		const before = providerCalls;
		await call("read_thread", { reference: randomUUID() });
		await call("read_messages", { cursor: randomUUID() });
		expect(providerCalls).toBe(before);
		await client.renew(async (sessionId) => {
			const token = "second-fixture-token-thirty-two-characters";
			if (sessionId) {
				expect(sessions.get(sessionId)?.token).toBe(currentToken);
				sessions.get(sessionId)!.token = token;
			}
			credential = { ...credential, token, sessionId };
			currentToken = token;
		});
		await call("read_thread", { reference: issued.reference });
		await call("read_messages", { cursor: issued.cursor });
		expect(providerCalls).toBe(before + (continuation ? 2 : 0));
		expect(initializations).toBe(continuation ? 1 : 2);
		issued = await history();
		const beforeExpiryDenials = deniedRequests;
		expiredReference = true;
		await expect(
			call("read_thread", { reference: issued.reference }),
		).rejects.toThrow("interrupted");
		expect(deniedRequests).toBe(beforeExpiryDenials + 1);
		expiredReference = false;
		issued = await history();
		const beforeRevoke = providerCalls;
		const beforeRevocationDenials = deniedRequests;
		revoked = true;
		await expect(
			call("read_thread", { reference: issued.reference }),
		).rejects.toThrow("interrupted");
		expect(providerCalls).toBe(beforeRevoke);
		expect(deniedRequests).toBeGreaterThan(beforeRevocationDenials);
		revoked = false;
		absent = true;
		await history();
		await expect(
			call("read_thread", { reference: randomUUID() }),
		).rejects.toThrow("interrupted");
		absent = false;
		malformed = true;
		await expect(history()).rejects.toThrow("interrupted");
		malformed = false;
		issued = await history();
		const peer = new ScopedAutomationMcpClient(
			"https://slack.fixture",
			() => a,
			() => credential,
			stop.signal,
		);
		try {
			const beforePeer = providerCalls;
			await peer.call(
				{ name: "read_thread", arguments: { reference: issued.reference } },
				randomUUID(),
				stop.signal,
			);
			expect(providerCalls).toBe(beforePeer);
		} finally {
			await peer.close();
		}
	} finally {
		stop.abort();
		await client.close();
		for (const session of sessions.values()) await session.server.close();
		await app.close();
		vi.unstubAllGlobals();
	}
});
