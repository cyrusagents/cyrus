import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import {
	type AutomationAuthority,
	admissionSchema,
	authorizeTool,
	checkpointKey,
	digest,
	type McpCredential,
	permittedToolNames,
	scopedToolSchemas,
} from "../src/automations/contract.js";
import {
	type NativeContext,
	nativeContextCalls,
	nativeContextRejection,
	nativeContextResult,
} from "../src/automations/NativeContext.js";
import { ScopedAutomationMcpClient } from "../src/automations/ScopedMcpClient.js";

const context: NativeContext = {
	contractVersion: 1,
	bindingId: "native-binding",
	scopeRef: "private-scope",
	permissions: ["read", "remember", "apply_approved", "work"],
};
function authority(): AutomationAuthority {
	return {
		contractVersion: 1,
		definition: {
			id: "general-automation",
			workspaceId: "workspace",
			ownerId: "operator",
			namespace: "private",
			scopeRef: context.scopeRef,
			revision: 1,
			state: "enabled",
			role: "coordinator",
			instruction: "Help",
			schedule: null,
			target: { harness: "codex", model: "gpt-5.5" },
			grants: [],
		},
		occurrenceId: "occurrence",
		attemptId: "attempt",
		fence: 1,
		leaseUntil: new Date(Date.now() + 60000).toISOString(),
		phase: "execute",
		input: "Remember",
		nativeContext: context,
	};
}
it("native authority is explicit, independent of provider resources and unavailable to children", () => {
	const a = authority();
	expect(permittedToolNames(a)).toEqual([
		"read_context",
		"remember_context",
		"track_work",
	]);
	const { nativeContext, ...wire } = a;
	expect(
		admissionSchema.parse({
			authority: wire,
			nativeContext,
			mcp: {
				token: "synthetic-credential-not-a-provider-token",
				grantId: context.bindingId,
				audience: "/mcp",
				expiresAt: a.leaseUntil,
			},
		}).nativeContext,
	).toEqual(context);
	expect(permittedToolNames({ ...a, nativeContext: undefined })).toEqual([]);
	for (const role of ["investigator", "engineering"] as const) {
		const child = { ...a, definition: { ...a.definition, role } };
		expect(permittedToolNames(child)).toEqual([]);
		expect(() =>
			authorizeTool(child, {
				name: "remember_context",
				arguments: { kind: "confirmed", body: "Forged" },
			}),
		).toThrow();
	}
	expect(
		permittedToolNames({
			...a,
			nativeContext: { ...context, scopeRef: "foreign" },
		}),
	).toEqual([]);
	for (const key of [
		"customerId",
		"workspaceId",
		"grantId",
		"role",
		"actionId",
		"idempotencyKey",
		"connectionId",
	]) {
		expect(() =>
			authorizeTool(a, {
				name: "remember_context",
				arguments: { kind: "confirmed", body: "Fact", [key]: "forged" },
			}),
		).toThrow();
	}
	expect(() =>
		authorizeTool(a, { name: "get_issue", arguments: {} }),
	).toThrow();
	const withProvider = {
		...a,
		definition: {
			...a.definition,
			grants: [
				{
					id: "provider-binding",
					accountId: "account",
					connectionId: "connection",
					resource: {
						provider: "linear" as const,
						teamId: "team",
						issueId: "issue",
					},
					permissions: ["read" as const],
				},
			],
		},
	};
	expect(permittedToolNames(withProvider)).toEqual([
		"read_context",
		"remember_context",
		"track_work",
		"get_issue",
	]);
	expect(
		scopedToolSchemas(a)
			.find((s) => s.shape.name.value === "read_context")!
			.parse({ name: "read_context", arguments: {} }),
	).toBeTruthy();
	expect(checkpointKey(a)).not.toBe(
		checkpointKey({ ...a, nativeContext: { ...context, bindingId: "other" } }),
	);
	expect(checkpointKey(a)).not.toBe(
		checkpointKey({
			...a,
			definition: { ...a.definition, workspaceId: "other" },
		}),
	);
	expect(checkpointKey(a)).toBe(
		checkpointKey({ ...a, attemptId: "next", fence: 2 }),
	);
});

it("SDK native context paginates, enforces session/scope, reconciles writes and denies retired approval execution", async () => {
	const a = authority();
	let credential: McpCredential = {
		grantId: context.bindingId,
		audience: "/mcp",
		token: "synthetic-context-token-not-a-real-secret",
		expiresAt: a.leaseUntil,
	};
	let revoked = false,
		foreign = false,
		policy: "automatic" | "legacy_pending" | "disabled" = "automatic",
		loseAck = false;
	const facts = Array.from({ length: 125 }, (_, i) => ({
		kind: "source",
		body: `Private fact ${i}`,
		provenance: "controlled authorized source",
	}));
	const receipts = new Map<
		string,
		{ payload: string; status: string; receiptId: string }
	>();
	let commits = 0;
	let toolRejection: Record<string, unknown> | undefined;
	const workItems: { objective: string; status: string }[] = [];
	let workCommits = 0;
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
		if (
			revoked ||
			request.headers.authorization !== `Bearer ${credential.token}`
		)
			return reply.code(401).send();
		const id = request.headers["mcp-session-id"] as string | undefined;
		let session = id ? sessions.get(id) : undefined;
		if (id && (!session || session.token !== credential.token))
			return reply.code(403).send();
		if (!session) {
			if ((request.body as { method?: string })?.method !== "initialize")
				return reply.code(403).send();
			const cursors = new Map<string, number>();
			const workRefs = new Map<string, number>();
			const server = new McpServer({
				name: "native-context-fixture",
				version: "1",
			});
			const transport = new StreamableHTTPServerTransport({
				sessionIdGenerator: randomUUID,
				enableJsonResponse: true,
				onsessioninitialized: (sid) => sessions.set(sid, session!),
			});
			session = { server, transport, token: credential.token };
			for (const schema of nativeContextCalls.filter((s) =>
				permittedToolNames(a).includes(s.shape.name.value),
			)) {
				const name = schema.shape.name.value;
				server.registerTool(
					name,
					{ inputSchema: schema.shape.arguments },
					async (args, extra) => {
						if (revoked) throw Error("Current authority revoked");
						const binding = {
							bindingId: foreign ? "foreign" : context.bindingId,
							scopeRef: context.scopeRef,
						};
						if (name === "read_context") {
							const cursor = (args as { cursor?: string }).cursor;
							if (cursor && !cursors.has(cursor))
								throw Error("Unissued cursor");
							const offset = cursor ? cursors.get(cursor)! : 0,
								nextCursor = offset + 25 < facts.length ? randomUUID() : null;
							if (nextCursor) cursors.set(nextCursor, offset + 25);
							return {
								content: [],
								structuredContent: {
									...binding,
									snapshotRevision: "current",
									entries: facts.slice(offset, offset + 25),
									work: workItems.map((w, index) => {
										const ref = randomUUID();
										workRefs.set(ref, index);
										return { reference: ref, ...w };
									}),
									inputEvidence: [
										{ reference: randomUUID(), description: "Current input" },
									],
									outcomes: [],
									nextCursor,
								},
							};
						}
						const key = String(extra._meta?.idempotencyKey),
							payload = digest({ name, args });
						if (toolRejection)
							return {
								isError: true,
								content: [
									{ type: "text" as const, text: "PRIVATE_PROVIDER_ERROR" },
								],
								structuredContent: {
									contractVersion: 1,
									kind: "tool_rejection",
									code: "invalid_reference",
									effect: "none",
									operationKey: key,
									...toolRejection,
								},
							};
						const old = receipts.get(key);
						if (old && old.payload !== payload)
							throw Error("Conflicting immutable write");
						if (!old) {
							if (name === "track_work") {
								const update = args as {
									reference?: string;
									objective?: string;
									status?: string;
								};
								if (update.reference && !workRefs.has(update.reference))
									throw Error("Foreign work reference");
								if (
									update.status &&
									["verified", "confirmed", "closed"].includes(update.status)
								)
									throw Error("No matching trusted proof");
							}
							const status =
								policy === "disabled"
									? "denied"
									: policy === "legacy_pending" && name === "remember_context"
										? "pending"
										: "applied";
							const receipt = { payload, status, receiptId: randomUUID() };
							receipts.set(key, receipt);
							if (status === "applied") {
								if (name === "track_work") {
									const update = args as {
										reference?: string;
										objective?: string;
										status?: string;
									};
									if (update.reference) {
										const item = workItems[workRefs.get(update.reference)!]!;
										if (update.objective) item.objective = update.objective;
										if (update.status) item.status = update.status;
									} else
										workItems.push({
											objective: update.objective!,
											status: "active",
										});
									workCommits++;
								} else {
									commits++;
									facts.push({
										kind: "confirmed",
										body: "One durable fact",
										provenance: "exact action ledger",
									});
								}
							}
						}
						const receipt = receipts.get(key)!;
						return {
							content: [],
							structuredContent: {
								...binding,
								status: receipt.status,
								receiptId: receipt.receiptId,
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
	const origin = await app.listen({ host: "127.0.0.1", port: 0 }),
		realFetch = globalThis.fetch;
	vi.stubGlobal("fetch", async (url: URL | string, init?: RequestInit) => {
		if (String(url) !== "https://context.fixture/mcp")
			throw Error("External request denied");
		const response = await realFetch(`${origin}/mcp`, init);
		if (
			loseAck &&
			(String(init?.body).includes('"remember_context"') ||
				String(init?.body).includes('"track_work"'))
		) {
			loseAck = false;
			await response.body?.cancel();
			throw Error("Lost write acknowledgement");
		}
		return response;
	});
	const controller = new AbortController(),
		client = new ScopedAutomationMcpClient(
			"https://context.fixture",
			() => a,
			() => credential,
			controller.signal,
		);
	const read = (cursor?: string) =>
		client.call(
			{ name: "read_context", arguments: cursor ? { cursor } : {} },
			"read-current",
			controller.signal,
		) as Promise<{ items: { text: string }[]; nextCursor: string | null }>;
	const remember = {
		name: "remember_context" as const,
		arguments: { kind: "confirmed" as const, body: "Remember this exact fact" },
	};
	try {
		await client.revalidate();
		let page = await read(),
			total = page.items.length - 1;
		const oldCursor = page.nextCursor!;
		while (page.nextCursor) {
			page = await read(page.nextCursor);
			total += page.items.length - 1;
		}
		expect(total).toBe(125);
		expect(await read(randomUUID())).toMatchObject({
			items: [{ text: expect.stringContaining("not issued") }],
		});
		for (const code of [
			"invalid_reference",
			"invalid_arguments",
			"proof_required",
		]) {
			toolRejection = { code };
			const rejected = await client.call(
				code === "proof_required"
					? {
							name: "track_work",
							arguments: { reference: randomUUID(), status: "verified" },
						}
					: remember,
				`rejected-${code}`,
				controller.signal,
			);
			expect(rejected).toMatchObject({
				items: [{ text: expect.any(String) }],
				nextCursor: null,
			});
			expect(
				JSON.parse((rejected as { items: { text: string }[] }).items[0]!.text),
			).toMatchObject({ status: "denied", code });
			expect(JSON.stringify(rejected)).not.toContain("PRIVATE_PROVIDER_ERROR");
			expect(JSON.stringify(rejected)).not.toContain(`rejected-${code}`);
			expect(commits).toBe(0);
		}
		toolRejection = {};
		loseAck = true;
		await expect(
			client.call(remember, "lost-rejection-ack", controller.signal),
		).rejects.toThrow("interrupted");
		expect(commits).toBe(0);
		expect(
			await client.call(remember, "lost-rejection-ack", controller.signal),
		).toMatchObject({
			items: [{ text: expect.stringContaining('"status":"denied"') }],
		});
		for (const malformed of [
			{ operationKey: "another-operation" },
			{ kind: "other" },
			{ contractVersion: 2 },
			{ effect: "unknown" },
			{ code: "authority_revoked" },
			{ code: "network_error" },
			{ code: "x".repeat(1025) },
			{ injected: "untrusted extra field" },
		]) {
			toolRejection = malformed;
			await expect(
				client.call(remember, "malformed", controller.signal),
			).rejects.toThrow("interrupted");
			expect(commits).toBe(0);
		}
		toolRejection = undefined;
		loseAck = true;
		await expect(
			client.call(remember, "immutable-write", controller.signal),
		).rejects.toThrow("interrupted");
		expect(commits).toBe(1);
		credential = {
			...credential,
			token: "rotated-context-token-still-not-real",
		};
		a.attemptId = "new-attempt";
		a.fence++;
		expect(
			await client.call(remember, "immutable-write", controller.signal),
		).toEqual({ items: [{ text: '{"status":"applied"}' }], nextCursor: null });
		expect(commits).toBe(1);
		await expect(
			client.call(
				{ ...remember, arguments: { ...remember.arguments, body: "Changed" } },
				"immutable-write",
				controller.signal,
			),
		).rejects.toThrow("interrupted");
		expect(commits).toBe(1);
		expect(await read(oldCursor)).toMatchObject({
			items: [{ text: expect.stringContaining("not issued") }],
		});
		// Older servers may return a historical pending receipt; it is not a saved fact.
		policy = "legacy_pending";
		expect(
			await client.call(remember, "proposal", controller.signal),
		).toMatchObject({ items: [{ text: '{"status":"pending"}' }] });
		expect(commits).toBe(1);
		await expect(
			client.call(
				{
					name: "apply_approved_action",
					arguments: { reference: randomUUID() },
				},
				"retired",
				controller.signal,
			),
		).rejects.toThrow();
		expect(commits).toBe(1);
		policy = "disabled";
		expect(
			await client.call(remember, "disabled", controller.signal),
		).toMatchObject({ items: [{ text: '{"status":"denied"}' }] });
		expect(commits).toBe(1);
		policy = "automatic";
		const create = {
			name: "track_work" as const,
			arguments: { objective: "Investigate the reported issue" },
		};
		loseAck = true;
		await expect(
			client.call(create, "create-work", controller.signal),
		).rejects.toThrow("interrupted");
		expect(workCommits).toBe(1);
		expect(
			await client.call(create, "create-work", controller.signal),
		).toMatchObject({ items: [{ text: '{"status":"applied"}' }] });
		expect(workCommits).toBe(1);
		page = await read();
		const workRef = JSON.parse(page.items[0]!.text).work[0].reference;
		expect(
			await client.call(
				{
					name: "track_work",
					arguments: { reference: workRef, status: "waiting" },
				},
				"work-waiting",
				controller.signal,
			),
		).toMatchObject({ items: [{ text: '{"status":"applied"}' }] });
		expect(workItems[0]!.status).toBe("waiting");
		await expect(
			client.call(
				{
					name: "track_work",
					arguments: {
						reference: workRef,
						status: "confirmed",
						outcome_reference: randomUUID(),
					},
				},
				"unproven",
				controller.signal,
			),
		).rejects.toThrow("interrupted");
		expect(workItems[0]!.status).toBe("waiting");
		await expect(
			client.call(
				{
					name: "track_work",
					arguments: { reference: workRef, status: "active" },
				},
				"stale-work-reference",
				controller.signal,
			),
		).rejects.toThrow("interrupted");
		expect(workCommits).toBe(2);
		foreign = true;
		await expect(read()).rejects.toThrow("interrupted");
		foreign = false;
		await read();
		revoked = true;
		await expect(client.revalidate()).rejects.toThrow("unavailable");
		await expect(read()).rejects.toThrow("interrupted");
		expect(commits).toBe(1);
	} finally {
		controller.abort();
		await client.close();
		for (const s of sessions.values()) await s.server.close();
		await app.close();
		vi.unstubAllGlobals();
	}
});

it("context result rejects foreign scope, oversized pages and forged fields without inventing provider grants", () => {
	const page = {
		bindingId: context.bindingId,
		scopeRef: context.scopeRef,
		snapshotRevision: "r",
		entries: [],
		nextCursor: null,
		approvedActions: [],
	};
	expect(nativeContextResult(context, "read_context", page)).toEqual({
		items: [{ text: '{"snapshotRevision":"r"}' }],
		nextCursor: null,
	});
	const reference = randomUUID();
	const extras = {
		inputEvidence: [{ reference, description: "Current admitted input" }],
		work: [{ reference, objective: "Inspect result", status: "waiting" }],
		outcomes: [{ reference, description: "Verified artifact" }],
	};
	expect(
		nativeContextResult(context, "read_context", { ...page, ...extras }),
	).toEqual({
		items: [
			{
				text: JSON.stringify({
					snapshotRevision: "r",
					...extras,
				}),
			},
		],
		nextCursor: null,
	});
	for (const change of [
		{ inputEvidence: Array(26).fill({ reference, description: "x" }) },
		{ work: [{ reference, objective: "x", status: "complete" }] },
		{ outcomes: [{ reference, description: "x", customerId: "forged" }] },
		{
			entries: Array(25).fill({
				kind: "source",
				body: "😀".repeat(2000),
				provenance: "input",
			}),
		},
		{ scopeRef: "another-customer" },
		{ bindingId: "another-workspace" },
		{ extra: "forged" },
		{
			entries: Array(26).fill({
				kind: "confirmed",
				body: "x",
				provenance: "input",
			}),
		},
		{
			entries: [
				{ kind: "confirmed", body: "x".repeat(4001), provenance: "input" },
			],
		},
	])
		expect(() =>
			nativeContextResult(context, "read_context", { ...page, ...change }),
		).toThrow();
	expect(() =>
		nativeContextResult(context, "remember_context", {
			...page,
			status: "applied",
			receiptId: "r",
		}),
	).toThrow();
});

it("work updates require the permission and strict issued-reference shape", () => {
	const a = authority();
	expect(() =>
		authorizeTool(a, {
			name: "track_work",
			arguments: { objective: "Investigate" },
		}),
	).not.toThrow();
	expect(() =>
		authorizeTool(a, {
			name: "track_work",
			arguments: { reference: randomUUID(), status: "waiting" },
		}),
	).not.toThrow();
	for (const args of [
		{ reference: randomUUID() },
		{ objective: "" },
		{ objective: "x".repeat(501) },
		{ objective: "x", status: "closed" },
		{ reference: randomUUID(), status: "done" },
		{ reference: randomUUID(), threadId: randomUUID(), status: "active" },
		{ reference: randomUUID(), outcome_reference: "raw-proof-id" },
	]) {
		expect(() =>
			authorizeTool(a, { name: "track_work", arguments: args }),
		).toThrow();
	}
	expect(() =>
		authorizeTool(
			{
				...a,
				nativeContext: { ...context, permissions: ["read", "remember"] },
			},
			{ name: "track_work", arguments: { objective: "x" } },
		),
	).toThrow();
});

it("legacy approval envelopes and receipt shapes do not expose an executable tool or model references", () => {
	const a = authority();
	const reference = randomUUID();
	expect(permittedToolNames(a)).not.toContain("apply_approved_action");
	expect(() =>
		authorizeTool(a, {
			name: "apply_approved_action",
			arguments: { reference },
		}),
	).toThrow();
	const page = {
		bindingId: context.bindingId,
		scopeRef: context.scopeRef,
		snapshotRevision: "legacy",
		entries: [],
		nextCursor: null,
		approvedActions: [{ reference, description: "Old proposal" }],
	};
	expect(nativeContextResult(context, "read_context", page)).toEqual({
		items: [{ text: '{"snapshotRevision":"legacy"}' }],
		nextCursor: null,
	});
	const { approvedActions, ...current } = page;
	expect(nativeContextResult(context, "read_context", current)).toEqual(
		nativeContextResult(context, "read_context", page),
	);
});

it.each([
	"publish_artifact",
	"reply",
	"add_comment",
	"delegate_investigation",
	"read_context",
])("no-effect native rejection cannot resolve an uncertain %s operation", (name) => {
	expect(() =>
		nativeContextRejection(name, "key", {
			contractVersion: 1,
			kind: "tool_rejection",
			code: "invalid_reference",
			effect: "none",
			operationKey: "key",
		}),
	).toThrow("Unsupported tool rejection");
});
