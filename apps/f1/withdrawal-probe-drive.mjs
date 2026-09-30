// Controlled authority/model/provider; actual registered runtime, SQLite and MCP SDK.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { AutomationRuntime } from "../../packages/edge-worker/dist/automations/AutomationRuntime.js";
import { AutomationCheckpointStore } from "../../packages/edge-worker/dist/automations/CheckpointStore.js";
import { AutomationLedger } from "../../packages/edge-worker/dist/automations/Ledger.js";
import { registerAutomationRoutes } from "../../packages/edge-worker/dist/automations/register.js";
import { ScopedAutomationMcpClient } from "../../packages/edge-worker/dist/automations/ScopedMcpClient.js";
import { instructionKey } from "../../packages/edge-worker/dist/automations/scheduling.js";
import { installWithdrawalProbe } from "./withdrawal-probe.mjs";

const require = createRequire(
	new URL("../../packages/edge-worker/package.json", import.meta.url),
);
const Fastify = require("fastify");
const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const {
	StreamableHTTPServerTransport,
} = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const {
	StreamableHTTPClientTransport,
} = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
const {
	ListToolsRequestSchema,
	CallToolRequestSchema,
	McpError,
	ErrorCode,
} = require("@modelcontextprotocol/sdk/types.js");
const sdk = { Client, StreamableHTTPClientTransport };
const until = async (predicate) => {
	const end = Date.now() + 15000;
	while (!predicate()) {
		if (Date.now() > end) throw Error("Withdrawal F1 condition timed out");
		await new Promise((r) => setTimeout(r, 10));
	}
};

export async function runWithdrawalDrive({
	reviseOnResume = false,
	sourceWithdrawal = false,
} = {}) {
	const directory = await mkdtemp(join(tmpdir(), "cyrus-withdrawal-f1-"));
	const definition = {
		id: "alpha",
		workspaceId: "workspace-fixture",
		ownerId: "operator",
		namespace: "internal-alpha",
		scopeRef: "internal-alpha",
		revision: 1,
		state: "enabled",
		role: "coordinator",
		instruction: "Read the disposable issue; re-list after session changes",
		schedule: null,
		target: { harness: "claude", model: "fixture" },
	};
	const customerId = randomUUID(),
		tokens = new Map(),
		sessions = new Map();
	const requests = [],
		results = [];
	const localControllers = [],
		toolClients = [],
		allReferences = [];
	let paused = false,
		reads = 0,
		tick = Date.now();
	const ledger = new AutomationLedger(
		join(directory, "ledger"),
		definition.workspaceId,
		() => tick,
	);
	const occurrenceId = instructionKey(definition, "read-only-fixture");
	const app = Fastify({ forceCloseConnections: true });
	app.all("/mcp", async (request, reply) => {
		if (request.method === "GET") return reply.code(405).send();
		const token = request.headers.authorization?.replace(/^Bearer /, ""),
			admitted = tokens.get(token);
		const method = request.body?.method;
		requests.push({
			method,
			at: Date.now(),
			revoked: !!admitted?.revoked,
			paused,
		});
		if (
			!admitted ||
			admitted.revoked ||
			paused ||
			admitted.expiresAt <= Date.now()
		)
			return reply.code(401).send({ error: "Scoped connection unavailable" });
		const sessionId = request.headers["mcp-session-id"];
		let session = sessions.get(sessionId);
		if (sessionId && (!session || session.token !== token))
			return reply.code(401).send();
		if (!session) {
			assert.equal(method, "initialize");
			const server = new Server(
				{ name: "withdrawal-fixture", version: "1" },
				{ capabilities: { tools: {} } },
			);
			const transport = new StreamableHTTPServerTransport({
				sessionIdGenerator: randomUUID,
				enableJsonResponse: true,
				onsessioninitialized: (id) => sessions.set(id, session),
			});
			const references = new Set();
			session = {
				server,
				transport,
				token,
				protocolVersion: request.body.params.protocolVersion,
			};
			server.setRequestHandler(ListToolsRequestSchema, async () => ({
				tools: [
					{
						name: "list_issues",
						inputSchema: {
							type: "object",
							properties: {},
							additionalProperties: false,
						},
					},
					{
						name: "get_issue",
						inputSchema: {
							type: "object",
							properties: { reference: { type: "string" } },
							required: ["reference"],
							additionalProperties: false,
						},
					},
				],
			}));
			server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
				let text;
				if (params.name === "list_issues") {
					const reference = randomUUID();
					references.add(reference);
					allReferences.push(reference);
					text = JSON.stringify({
						issues: [{ reference, identifier: "FIXTURE-1" }],
						held: 0,
					});
				} else {
					assert.equal(params.name, "get_issue");
					if (!references.has(params.arguments.reference))
						throw new McpError(
							ErrorCode.InvalidRequest,
							"Scoped connection unavailable",
						);
					reads++;
					text = "Disposable fixture content";
				}
				return {
					content: [],
					structuredContent: {
						items: [{ ...admitted.grant, text }].map(
							({ permissions: _p, id, ...item }) => ({ ...item, grantId: id }),
						),
						nextCursor: null,
					},
				};
			});
			await server.connect(transport);
		}
		if (
			sessionId &&
			request.headers["mcp-protocol-version"] !== session.protocolVersion
		)
			return reply.code(400).send();
		reply.hijack();
		await session.transport.handleRequest(request.raw, reply.raw, request.body);
	});
	const origin = await app.listen({ host: "127.0.0.1", port: 0 }),
		realFetch = globalThis.fetch;
	globalThis.fetch = (url, init) => {
		if (String(url) !== "https://withdrawal.fixture/mcp")
			throw Error("External network denied");
		return realFetch(`${origin}/mcp`, init);
	};
	const target = {
		workspaceId: definition.workspaceId,
		automationId: definition.id,
		revision: 1,
		scopeRef: definition.scopeRef,
		linearCustomerId: customerId,
	};
	const probe = installWithdrawalProbe(ScopedAutomationMcpClient, sdk, {
		target,
		origin: "https://withdrawal.fixture",
		mode: sourceWithdrawal ? "source-withdrawal" : "pause",
	});
	const modelSteps = new Map();
	let admittedAttempt;
	const runtime = new AutomationRuntime({
		workspaceId: () => definition.workspaceId,
		ledger,
		store: new AutomationCheckpointStore(join(directory, "checkpoints")),
		readiness: () => ({ ...definition.target, reason: null }),
		gateway: {
			async call(endpoint, body) {
				if (endpoint === "authorize") {
					if (paused) throw Error("Controlled pause");
					const token = `private-fixture-${randomUUID()}`;
					const grant = {
						id: "stable-grant",
						connectionId: "fixture-connection",
						accountId: "fixture-account",
						resource: { provider: "linear", customerId },
						permissions: ["read"],
					};
					const expiresAt = Date.now() + 60000;
					tokens.set(token, { expiresAt, grant, revoked: false });
					admittedAttempt = body.attemptId;
					return {
						authority: {
							contractVersion: 1,
							definition: { ...definition, grants: [grant] },
							occurrenceId: body.occurrenceId,
							attemptId: body.attemptId,
							fence: body.fence,
							phase: "execute",
							input: body.occurrence.input,
							leaseUntil: new Date(expiresAt).toISOString(),
						},
						mcp: {
							token,
							audience: "/mcp",
							grantId: grant.id,
							expiresAt: new Date(expiresAt).toISOString(),
						},
					};
				}
				if (endpoint === "progress") return {};
				results.push(body);
				return {
					contractVersion: 1,
					acknowledged: true,
					occurrenceId: body.occurrenceId,
					idempotencyKey: body.idempotencyKey,
				};
			},
		},
		model: {
			async next(messages) {
				const step = modelSteps.get(admittedAttempt) ?? 0;
				modelSteps.set(admittedAttempt, step + 1);
				if (step === 0)
					return { type: "tool", call: { name: "list_issues", arguments: {} } };
				if (step === 1) {
					const reference = JSON.parse(
						JSON.parse(messages.at(-1).content).items[0].text,
					).issues[0].reference;
					return {
						type: "tool",
						call: {
							name: "get_issue",
							arguments: { reference },
						},
					};
				}
				return { type: "result", text: "Read-only fixture completed" };
			},
		},
		tools: (a, c, s) => {
			const local = new AbortController();
			localControllers.push(local);
			const client = new ScopedAutomationMcpClient(
				"https://withdrawal.fixture",
				a,
				c,
				AbortSignal.any([s, local.signal]),
			);
			toolClients.push(client);
			return client;
		},
	});
	const registered = Fastify({ forceCloseConnections: true });
	registerAutomationRoutes(
		registered,
		runtime,
		() => "private-fixture-supervisor",
	);
	const post = (path, payload) =>
		registered.inject({
			method: "POST",
			url: `/api/automations/v1/${path}`,
			headers: { authorization: "Bearer private-fixture-supervisor" },
			payload,
		});
	try {
		assert.equal(
			(
				await registered.inject({
					method: "POST",
					url: "/api/automations/v1/wake",
					payload: { contractVersion: 1 },
				})
			).statusCode,
			401,
		);
		assert.equal(
			(await post("definitions", { contractVersion: 1, definition }))
				.statusCode,
			200,
		);
		await probe.command({ op: "arm", occurrenceId });
		assert.equal(
			(
				await post("occurrences", {
					contractVersion: 1,
					automationId: definition.id,
					revision: 1,
					eventId: "read-only-fixture",
					input: "Read only",
				})
			).statusCode,
			200,
		);
		await until(() => probe.status().phase === "ready");
		const first = ledger.status(definition.id).occurrences[0];
		assert.equal(reads, 1);
		localControllers[0].abort(); // prove local abort alone cannot fabricate this gate
		let renewalRan = false;
		const queued = toolClients[0]
			.renew(async () => {
				renewalRan = true;
			})
			.catch(() => {});
		await new Promise((r) => setTimeout(r, 5));
		assert.equal(renewalRan, false);
		await assert.rejects(
			probe.command({
				op: "probe-paused",
				confirmedAt: new Date().toISOString(),
				token: "forged",
			}),
		);
		if (sourceWithdrawal) {
			paused = true;
			for (const value of tokens.values()) value.revoked = true;
			// Production registered definition delivery fences old work on Remove.
			definition.revision = 2;
			definition.state = "enabled"; // source-free binding; gateway denies removed mapping
			assert.equal(
				(await post("definitions", { contractVersion: 1, definition }))
					.statusCode,
				200,
			);
			await assert.rejects(
				probe.command({
					op: "probe-paused",
					confirmedAt: new Date().toISOString(),
				}),
			);
			assert.equal(
				(
					await probe.command({
						op: "probe-removed",
						confirmedAt: new Date().toISOString(),
					})
				).phase,
				"removed-proven",
			);
			await queued;
			await until(
				() =>
					ledger
						.status(definition.id)
						.occurrences.find((o) => o.id === occurrenceId).status ===
					"cancelled",
			);
			const retry = await post("retry", {
				contractVersion: 1,
				workspaceId: definition.workspaceId,
				automationId: definition.id,
				revision: 1,
				occurrenceId,
				expectedFence: 1,
				commandId: randomUUID(),
			});
			assert.equal(retry.statusCode, 409);
			assert.equal(reads, 1);
			assert.equal(results.length, 0);
			// Picker restores mapping, then normal instruction upgrades the binding.
			paused = false;
			assert.equal(
				(
					await probe.command({
						op: "probe-reconnected",
						confirmedAt: new Date().toISOString(),
					})
				).phase,
				"reconnected-proven",
			);
			for (const bad of [
				{ occurrenceId, revision: 3 },
				{ occurrenceId: "new-occurrence", revision: 1 },
				{ occurrenceId: "new-occurrence", revision: 3, scopeRef: "foreign" },
			])
				await assert.rejects(probe.command({ op: "arm-current", ...bad }));
			definition.revision = 3;
			definition.state = "enabled";
			assert.equal(
				(await post("definitions", { contractVersion: 1, definition }))
					.statusCode,
				200,
			);
			const newOccurrenceId = instructionKey(
				definition,
				"new-read-after-reconnect",
			);
			assert.equal(
				(
					await probe.command({
						op: "arm-current",
						occurrenceId: newOccurrenceId,
						revision: 3,
					})
				).phase,
				"awaiting-new-occurrence",
			);
			assert.equal(
				(
					await post("occurrences", {
						contractVersion: 1,
						automationId: definition.id,
						revision: 3,
						eventId: "new-read-after-reconnect",
						input: "New authorized read",
					})
				).statusCode,
				200,
			);
			await until(
				() =>
					ledger
						.status(definition.id)
						.occurrences.find((o) => o.id === newOccurrenceId)?.status ===
					"completed",
			);
			assert.equal(probe.status().phase, "complete");
			const occurrences = ledger.status(definition.id).occurrences;
			const original = occurrences.find((o) => o.id === occurrenceId),
				current = occurrences.find((o) => o.id === newOccurrenceId);
			assert.equal(original.status, "cancelled");
			assert.equal(original.attempts, 1);
			assert.equal(current.attempts, 1);
			assert.equal(current.revision, 3);
			const staleAfterReconnect = await post("retry", {
				contractVersion: 1,
				workspaceId: definition.workspaceId,
				automationId: definition.id,
				revision: 1,
				occurrenceId,
				expectedFence: 1,
				commandId: randomUUID(),
			});
			assert.equal(staleAfterReconnect.statusCode, 409);
			assert.equal(reads, 2);
			assert.equal(results.length, 1);
			const evidence = probe.status();
			assert.deepEqual(
				evidence.events
					.filter((e) => e.type === "probe")
					.map((e) => [e.label, e.httpStatus, e.mcpCode, e.denied]),
				[
					["removed-list", 401, null, true],
					["removed-read", 401, null, true],
					["reconnected-old-credential", 401, null, true],
					["new-session-old-reference", 200, -32600, true],
				],
			);
			for (const secret of [
				...tokens.keys(),
				...sessions.keys(),
				...allReferences,
				"Disposable fixture content",
			])
				assert.ok(!JSON.stringify(evidence).includes(secret));
			return {
				passed: true,
				sourceWithdrawal: true,
				originalRevision: 1,
				removedRevision: 2,
				currentRevision: 3,
				originalOccurrenceCancelled: true,
				originalAttempts: original.attempts,
				staleRetryStatus: retry.statusCode,
				staleRetryAfterReconnectStatus: staleAfterReconnect.statusCode,
				newOccurrence: newOccurrenceId !== occurrenceId,
				currentAttempts: current.attempts,
				providerReads: reads,
				results: results.length,
				evidence,
				limitations: [
					"Actual installed/source runtime, SQLite and SDK. Controlled mapping/Hosted/model/provider, not live SQL or UI proof.",
				],
			};
		}
		const pausedAt = new Date().toISOString();
		paused = true;
		for (const value of tokens.values()) value.revoked = true;
		assert.equal(
			(await probe.command({ op: "probe-paused", confirmedAt: pausedAt }))
				.phase,
			"paused-proven",
		);
		assert.equal(renewalRan, false);
		paused = false;
		assert.equal(
			(
				await probe.command({
					op: "probe-resumed",
					confirmedAt: new Date().toISOString(),
				})
			).phase,
			"awaiting-recovery",
		);
		if (reviseOnResume) {
			assert.equal(
				(
					await post("definitions", {
						contractVersion: 1,
						definition: { ...definition, revision: 2 },
					})
				).statusCode,
				200,
			);
			await queued;
			await until(
				() =>
					ledger.status(definition.id).occurrences[0].status === "cancelled",
			);
			const deniedRetry = await post("retry", {
				contractVersion: 1,
				workspaceId: definition.workspaceId,
				automationId: definition.id,
				revision: 1,
				occurrenceId,
				expectedFence: 1,
				commandId: randomUUID(),
			});
			assert.equal(deniedRetry.statusCode, 409);
			assert.equal(reads, 1);
			assert.equal(results.length, 0);
			await probe.command({ op: "cancel" });
			return {
				passed: true,
				withdrawalGateComplete: false,
				bindingRevisionChange: true,
				originalOccurrenceCancelled: true,
				staleRetryStatus: 409,
				providerReads: reads,
				results: 0,
				evidence: probe.status(),
			};
		}
		await queued;
		assert.equal(renewalRan, true);
		await until(
			() => ledger.status(definition.id).occurrences[0].status === "queued",
		);
		tick += 6000;
		await post("wake", { contractVersion: 1 });
		await until(
			() => ledger.status(definition.id).occurrences[0].status === "completed",
		);
		assert.equal(probe.status().phase, "complete");
		const last = ledger.status(definition.id).occurrences[0];
		assert.equal(last.id, first.id);
		assert.equal(last.input, first.input);
		assert.equal(last.attempts, 2);
		assert.equal(last.fence, 2);
		assert.equal(reads, 2);
		assert.equal(results.length, 1);
		const evidence = probe.status();
		assert.deepEqual(
			evidence.events
				.filter((e) => e.type === "probe")
				.map((e) => [e.label, e.httpStatus, e.mcpCode, e.denied]),
			[
				["paused-list", 401, null, true],
				["paused-read", 401, null, true],
				["resumed-old-credential", 401, null, true],
				["new-session-old-reference", 200, -32600, true],
			],
		);
		const serialized = JSON.stringify(evidence);
		for (const secret of [
			...tokens.keys(),
			...sessions.keys(),
			...allReferences,
			"Disposable fixture content",
		])
			assert.ok(!serialized.includes(secret));
		return {
			passed: true,
			registeredInstruction: true,
			attempts: last.attempts,
			providerReads: reads,
			results: results.length,
			evidence,
			limitations: [
				"Actual registered runtime/SQLite/SDK; controlled Hosted/model/provider. No live preview or provider mutation; Docker/model containment unchanged and not exercised by this narrow probe drive.",
			],
		};
	} catch (error) {
		console.error(
			JSON.stringify({
				phase: probe.status().phase,
				requests,
				occurrences: ledger
					.status(definition.id)
					.occurrences.map(({ status, lastFailure }) => ({
						status,
						lastFailure,
					})),
				modelSteps: [...modelSteps.values()],
			}),
		);
		throw error;
	} finally {
		probe.dispose();
		await registered.close();
		await runtime.stop();
		ledger.close();
		for (const s of sessions.values()) await s.server.close();
		await app.close();
		globalThis.fetch = realFetch;
	}
}
if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	runWithdrawalDrive({
		reviseOnResume: process.argv.includes("--revision-change"),
		sourceWithdrawal: process.argv.includes("--source-withdrawal"),
	})
		.then((r) => console.log(JSON.stringify(r, null, 2)))
		.catch((e) => {
			console.error(e);
			process.exitCode = 1;
		});
}
