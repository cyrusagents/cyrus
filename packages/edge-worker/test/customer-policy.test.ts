import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import {
	assertCustomerPolicyRecovery,
	customerPolicySchema,
	engineeringSubmissionReceiptSchema,
} from "../src/automations/CustomerPolicy.js";
import {
	type AutomationAuthority,
	authorizeTool,
	permittedToolNames,
	scopedToolResult,
} from "../src/automations/contract.js";

function authority(): AutomationAuthority {
	return {
		contractVersion: 1,
		occurrenceId: "occurrence",
		attemptId: "attempt",
		fence: 1,
		leaseUntil: new Date(Date.now() + 60000).toISOString(),
		phase: "execute",
		input: "Read authorized source",
		customerPolicy: {
			version: 1,
			epoch: randomUUID(),
			linearDisclosure: "email-origin-v1",
		},
		oneWayEngineering: true,
		nativeContext: {
			contractVersion: 1,
			bindingId: "binding",
			scopeRef: "customer-a",
			permissions: ["read"],
		},
		definition: {
			id: "definition",
			workspaceId: "workspace-a",
			ownerId: "owner",
			namespace: "customer",
			scopeRef: "customer-a",
			revision: 1,
			state: "enabled",
			role: "coordinator",
			instruction: "Use current authority",
			schedule: null,
			target: { harness: "codex", model: "fixture" },
			grants: [
				{
					id: "binding",
					connectionId: "connection",
					accountId: "account",
					resource: { provider: "linear", customerId: randomUUID() },
					permissions: ["read", "delegate"],
				},
			],
		},
	};
}
function result(a: AutomationAuthority, value: unknown) {
	const g = a.definition.grants[0]!;
	return {
		items: [
			{
				grantId: g.id,
				connectionId: g.connectionId,
				accountId: g.accountId,
				resource: g.resource,
				text: JSON.stringify(value),
			},
		],
		nextCursor: null,
	};
}
it("allows only identifier/status projections or the authenticated email disclosure branch", () => {
	const a = authority(),
		call = {
			name: "get_issue" as const,
			arguments: { reference: randomUUID() },
		};
	const restricted = {
		disclosure: "identifier_status",
		issue: { identifier: "CYHOST-52", status: "Todo" },
	};
	expect(scopedToolResult(a, call, result(a, restricted))).toEqual({
		items: [{ text: JSON.stringify(restricted) }],
		nextCursor: null,
	});
	for (const field of [
		"title",
		"description",
		"comments",
		"attachments",
		"customerId",
		"affectedCustomers",
		"url",
	])
		expect(() =>
			scopedToolResult(
				a,
				call,
				result(a, {
					...restricted,
					issue: { ...restricted.issue, [field]: "FOREIGN_SECRET" },
				}),
			),
		).toThrow();
	const full = {
		disclosure: "verified_customer_email",
		issue: {
			identifier: "CYHOST-52",
			status: "Todo",
			title: "Customer email",
			description: null,
		},
	};
	expect(scopedToolResult(a, call, result(a, full))).toEqual({
		items: [{ text: JSON.stringify(full) }],
		nextCursor: null,
	});
	expect(() =>
		scopedToolResult(
			a,
			call,
			result(a, { ...full, provenance: "email claimed in text" }),
		),
	).toThrow();
	const foreign = result(a, restricted);
	foreign.items[0]!.connectionId = "other-account";
	expect(() => scopedToolResult(a, call, foreign)).toThrow("Unscoped");
});
it("lists no hidden counts, titles or private relationships", () => {
	const a = authority(),
		call = { name: "list_issues" as const, arguments: {} },
		listed = {
			issues: [
				{ reference: randomUUID(), identifier: "CYHOST-52", status: "Done" },
			],
		};
	expect(scopedToolResult(a, call, result(a, listed))).toEqual({
		items: [{ text: JSON.stringify(listed) }],
		nextCursor: null,
	});
	for (const extra of [
		{ held: 1 },
		{ customers: ["other"] },
		{ totalCount: 2 },
	])
		expect(() =>
			scopedToolResult(a, call, result(a, { ...listed, ...extra })),
		).toThrow();
	expect(() =>
		scopedToolResult(
			a,
			call,
			result(a, { issues: [{ ...listed.issues[0], title: "private" }] }),
		),
	).toThrow();
});
it("one-way coordinator submission has no authority arguments, child tool or return channel", () => {
	const a = authority();
	expect(permittedToolNames(a)).toEqual([
		"read_context",
		"submit_engineering_request",
		"list_issues",
		"get_issue",
	]);
	expect(
		authorizeTool(a, {
			name: "submit_engineering_request",
			arguments: { request: "Investigate" },
		}),
	).toBeUndefined();
	for (const field of [
		"workspaceId",
		"customerId",
		"pmId",
		"repositoryId",
		"parentSessionId",
		"callback",
		"role",
	])
		expect(() =>
			authorizeTool(a, {
				name: "submit_engineering_request",
				arguments: { request: "Investigate", [field]: "foreign" },
			}),
		).toThrow();
	const worker = structuredClone(a);
	worker.definition.role = "investigator";
	expect(() =>
		authorizeTool(worker, {
			name: "submit_engineering_request",
			arguments: { request: "Investigate" },
		}),
	).toThrow();
	const sourceFree = structuredClone(a);
	sourceFree.definition.grants = [];
	expect(
		authorizeTool(sourceFree, {
			name: "submit_engineering_request",
			arguments: { request: "Investigate" },
		}),
	).toBeUndefined();
	delete sourceFree.oneWayEngineering;
	expect(() =>
		authorizeTool(sourceFree, {
			name: "submit_engineering_request",
			arguments: { request: "Investigate" },
		}),
	).toThrow();
	const receipt = { submissionId: randomUUID(), status: "accepted" };
	expect(engineeringSubmissionReceiptSchema.parse(receipt)).toEqual(receipt);
	for (const field of [
		"result",
		"transcript",
		"pmSessionId",
		"affectedCustomers",
	])
		expect(() =>
			engineeringSubmissionReceiptSchema.parse({
				...receipt,
				[field]: "private",
			}),
		).toThrow();
});
it("policy changes and pre-policy transcripts cannot resume, but immutable terminal receipts survive", () => {
	const before = authority().customerPolicy!,
		after = { ...before, epoch: randomUUID() };
	expect(() =>
		assertCustomerPolicyRecovery(before, { ...before }, false),
	).not.toThrow();
	for (const [prior, next] of [
		[undefined, before],
		[before, undefined],
		[before, after],
	] as const) {
		expect(() => assertCustomerPolicyRecovery(prior, next, false)).toThrow(
			"fresh admitted occurrence",
		);
		expect(() => assertCustomerPolicyRecovery(prior, next, true)).not.toThrow();
	}
	expect(() =>
		customerPolicySchema.parse({ ...before, linearDisclosure: "all-linked" }),
	).toThrow();
	expect(() =>
		customerPolicySchema.parse({ ...before, customerId: "model-selected" }),
	).toThrow();
});

it("real SDK preserves restricted references and reconciles a one-way submission after lost ACK", async () => {
	const [
		{ McpServer },
		{ StreamableHTTPServerTransport },
		{ default: Fastify },
		{ ScopedAutomationMcpClient },
		{ vi },
	] = await Promise.all([
		import("@modelcontextprotocol/sdk/server/mcp.js"),
		import("@modelcontextprotocol/sdk/server/streamableHttp.js"),
		import("fastify"),
		import("../src/automations/ScopedMcpClient.js"),
		import("vitest"),
	]);
	const a = authority(),
		token = "synthetic-customer-policy-test-token-no-secret",
		reference = randomUUID(),
		receipts = new Map<string, { submissionId: string; status: "accepted" }>();
	let malformed = false,
		revoked = false,
		loseAck = true,
		calls = 0;
	const app = Fastify({ forceCloseConnections: true }),
		servers: Array<{
			server: InstanceType<typeof McpServer>;
			transport: InstanceType<typeof StreamableHTTPServerTransport>;
		}> = [];
	const submittedPayloads = new Map<string, string>();
	const sessions = new Map<
		string,
		InstanceType<typeof StreamableHTTPServerTransport>
	>();
	const { scopedToolSchemas } = await import("../src/automations/contract.js");
	app.all("/mcp", async (request, reply) => {
		if (request.headers.authorization !== `Bearer ${token}` || revoked)
			return reply.code(403).send();
		if (request.method === "GET") return reply.code(405).send();
		const body = request.body as { method?: string },
			session = request.headers["mcp-session-id"] as string | undefined;
		let transport = session ? sessions.get(session) : undefined;
		if (session && !transport) return reply.code(403).send();
		if (!transport) {
			if (body?.method !== "initialize") return reply.code(403).send();
			const server = new McpServer({
				name: "customer-policy-fixture",
				version: "1",
			});
			transport = new StreamableHTTPServerTransport({
				sessionIdGenerator: randomUUID,
				enableJsonResponse: true,
				onsessioninitialized: (id) => sessions.set(id, transport!),
			});
			const issued = new Set<string>();
			for (const schema of scopedToolSchemas(a)) {
				const name = schema.shape.name.value;
				server.registerTool(
					name,
					{ inputSchema: schema.shape.arguments },
					async (args, extra) => {
						calls++;
						if (name === "submit_engineering_request") {
							const key = extra._meta?.idempotencyKey as string;
							expect(key).toMatch(/^[a-f0-9]{64}$/);
							if (submittedPayloads.has(key))
								expect(submittedPayloads.get(key)).toBe(JSON.stringify(args));
							else {
								if (args.reference && !issued.has(args.reference as string))
									throw Error("Reference not admitted by current session");
								submittedPayloads.set(key, JSON.stringify(args));
							}
							if (!receipts.has(key))
								receipts.set(key, {
									submissionId: randomUUID(),
									status: "accepted",
								});
							return { content: [], structuredContent: receipts.get(key)! };
						}
						if (name === "list_issues") issued.add(reference);
						const payload =
							name === "list_issues"
								? {
										issues: [
											{ reference, identifier: "TEST-52", status: "Todo" },
										],
									}
								: {
										disclosure: "identifier_status",
										issue: {
											identifier: "TEST-52",
											status: "Todo",
											...(malformed ? { title: "FOREIGN_SECRET" } : {}),
										},
									};
						return { content: [], structuredContent: result(a, payload) };
					},
				);
			}
			servers.push({ server, transport });
			await server.connect(transport);
		}
		reply.hijack();
		await transport.handleRequest(request.raw, reply.raw, request.body);
	});
	const origin = await app.listen({ host: "127.0.0.1", port: 0 }),
		originalFetch = globalThis.fetch;
	vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
		if (String(url) !== "https://customer-policy.fixture/mcp")
			throw Error("External network denied");
		const response = await originalFetch(`${origin}/mcp`, init);
		if (
			loseAck &&
			receipts.size > 0 &&
			typeof init?.body === "string" &&
			JSON.parse(init.body).params?.name === "submit_engineering_request"
		) {
			loseAck = false;
			await response.body?.cancel();
			throw Error("Lost committed submission ACK");
		}
		return response;
	});
	const signal = new AbortController().signal;
	const client = new ScopedAutomationMcpClient(
		"https://customer-policy.fixture",
		() => a,
		() => ({
			token,
			grantId: a.definition.grants[0]!.id,
			audience: "/mcp",
			expiresAt: a.leaseUntil,
		}),
		signal,
	);
	const key = "a".repeat(64);
	try {
		await client.call(
			{ name: "list_issues", arguments: {} },
			"b".repeat(64),
			signal,
		);
		expect(
			await client.call(
				{ name: "get_issue", arguments: { reference } },
				"c".repeat(64),
				signal,
			),
		).toEqual({
			items: [
				{
					text: JSON.stringify({
						disclosure: "identifier_status",
						issue: { identifier: "TEST-52", status: "Todo" },
					}),
				},
			],
			nextCursor: null,
		});
		const before = calls;
		await expect(
			client.call(
				{
					name: "submit_engineering_request",
					arguments: { request: "Please investigate", reference: randomUUID() },
				},
				key,
				signal,
			),
		).rejects.toThrow();
		expect(calls).toBe(before + 1);
		expect(receipts.size).toBe(0);
		await client.call(
			{ name: "list_issues", arguments: {} },
			"b".repeat(64),
			signal,
		);
		const call = {
			name: "submit_engineering_request" as const,
			arguments: { request: "Please investigate", reference },
		};
		await expect(client.call(call, key, signal)).rejects.toThrow();
		expect(receipts.size).toBe(1);
		expect(await client.call(call, key, signal)).toEqual({
			items: [{ text: JSON.stringify(receipts.get(key)) }],
			nextCursor: null,
		});
		expect(receipts.size).toBe(1);
		await client.call(
			{ name: "list_issues", arguments: {} },
			"b".repeat(64),
			signal,
		);
		malformed = true;
		await expect(
			client.call(
				{ name: "get_issue", arguments: { reference } },
				"c".repeat(64),
				signal,
			),
		).rejects.toThrow();
		malformed = false;
		await client.call(
			{ name: "list_issues", arguments: {} },
			"b".repeat(64),
			signal,
		);
		revoked = true;
		const beforeRevocation = calls;
		await expect(client.call(call, key, signal)).rejects.toThrow();
		expect(calls).toBe(beforeRevocation);
	} finally {
		await client.close();
		vi.unstubAllGlobals();
		await Promise.all(servers.map((s) => s.server.close()));
		await app.close();
	}
});
