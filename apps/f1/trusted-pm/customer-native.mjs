// Actual contained Codex + MCP SDK + SQLite; controlled Hosted/model/provider.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { nativeOracle } from "../native-context-join/oracle-native.mjs";

const edge = resolve(
	process.env.CYRUS_F1_EDGE_DIST ?? "packages/edge-worker/dist",
);
const codex = resolve(
	process.env.CYRUS_F1_CODEX_DIST ?? "packages/codex-runner/dist",
);
const load = (name) =>
	import(pathToFileURL(join(edge, "automations", `${name}.js`)));
const require = createRequire(join(edge, "../package.json"));
const Fastify = require("fastify");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const {
	StreamableHTTPServerTransport,
} = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { AutomationRuntime } = await load("AutomationRuntime");
const { AutomationLedger } = await load("Ledger");
const { AutomationCheckpointStore } = await load("CheckpointStore");
const { ScopedAutomationMcpClient } = await load("ScopedMcpClient");
const { scopedToolSchemas, executionAuthority } = await load("contract");
const { sessionDeliveryDigest } = await import(
	pathToFileURL(join(edge, "sinks/session-delivery.js"))
);
const workDetails = process.env.CYRUS_F1_WORK_DETAILS === "1";
const home = await mkdtemp(join(tmpdir(), "cyrus-customer-policy-native-"));
const originalFetch = globalThis.fetch;
const definition = {
	id: randomUUID(),
	workspaceId: "workspace",
	ownerId: "operator",
	namespace: "customer",
	scopeRef: "customer-a",
	revision: 1,
	state: "enabled",
	role: "coordinator",
	instruction: workDetails
		? "Update waiting details on existing work. Do not send messages or schedule execution."
		: "Read permitted sources and submit the engineering request one way. Do not send messages.",
	schedule: null,
	target: { harness: "codex", model: "gpt-5.5" },
};
const grant = {
	id: randomUUID(),
	connectionId: "linear-connection",
	accountId: "linear-account",
	resource: { provider: "linear", customerId: randomUUID() },
	permissions: ["read"],
};
const context = {
	contractVersion: 1,
	bindingId: grant.id,
	scopeRef: definition.scopeRef,
	permissions: workDetails ? ["read", "work"] : ["read"],
	...(workDetails ? { workDetails: "waiting-v1" } : {}),
};
const work = {
	reference: randomUUID(),
	objective: "Inspect reproduction",
	status: "active",
};
let policy = {
		version: 1,
		epoch: randomUUID(),
		linearDisclosure: "email-origin-v1",
	},
	clock = Date.now(),
	latest,
	modelSteps = 0,
	lostWrite = true,
	lostResult = true,
	resultTransmissions = 0;
const effects = new Map(),
	results = new Set(),
	receipts = new Map(),
	reference = randomUUID(),
	emailReference = randomUUID();
const ledger = new AutomationLedger(
	join(home, "ledger"),
	"workspace",
	() => clock,
);
const store = new AutomationCheckpointStore(join(home, "checkpoints"));
ledger.upsert(definition);
const occurrence = ledger.enqueue(
	definition.id,
	1,
	"request",
	"Investigate the reported behavior.",
);
const app = Fastify({ forceCloseConnections: true }),
	servers = [],
	sessions = new Map();
app.all("/mcp", async (request, reply) => {
	if (
		request.headers.authorization !==
		"Bearer synthetic-scoped-token-for-policy-fixture-only"
	)
		return reply.code(403).send();
	if (request.method === "GET") return reply.code(405).send();
	let transport = sessions.get(request.headers["mcp-session-id"]);
	if (request.headers["mcp-session-id"] && !transport)
		return reply.code(403).send();
	if (!transport) {
		if (request.body?.method !== "initialize") return reply.code(403).send();
		const server = new McpServer({
				name: "customer-policy-native",
				version: "1",
			}),
			issued = new Set();
		transport = new StreamableHTTPServerTransport({
			sessionIdGenerator: randomUUID,
			enableJsonResponse: true,
			onsessioninitialized: (id) => sessions.set(id, transport),
		});
		for (const schema of scopedToolSchemas(latest)) {
			const name = schema.shape.name.value;
			server.registerTool(
				name,
				{ inputSchema: schema.shape.arguments },
				async (args, extra) => {
					if (name === "read_context")
						return {
							content: [],
							structuredContent: {
								bindingId: context.bindingId,
								scopeRef: context.scopeRef,
								snapshotRevision: "current",
								entries: [],
								nextCursor: null,
								...(workDetails ? { work: [{ ...work }] } : {}),
							},
						};
					if (name === "track_work") {
						assert.equal(args.reference, work.reference);
						const key = extra._meta.idempotencyKey;
						if (effects.has(key))
							assert.equal(effects.get(key).payload, JSON.stringify(args));
						else {
							for (const [field, value] of Object.entries(args)) {
								if (field === "reference") continue;
								if (value === null) delete work[field];
								else work[field] = value;
							}
							effects.set(key, {
								payload: JSON.stringify(args),
								receipt: {
									bindingId: context.bindingId,
									scopeRef: context.scopeRef,
									status: "applied",
									receiptId: randomUUID(),
								},
							});
						}
						return { content: [], structuredContent: effects.get(key).receipt };
					}
					if (name === "submit_engineering_request") {
						const key = extra._meta.idempotencyKey;
						if (effects.has(key))
							assert.equal(effects.get(key).payload, JSON.stringify(args));
						else {
							assert.ok(issued.has(args.reference));
							effects.set(key, {
								payload: JSON.stringify(args),
								receipt: { submissionId: randomUUID(), status: "accepted" },
							});
						}
						return { content: [], structuredContent: effects.get(key).receipt };
					}
					let value;
					if (name === "list_issues") {
						issued.add(reference);
						issued.add(emailReference);
						value = {
							issues: [
								{ reference, identifier: "PRIVATE-1", status: "Todo" },
								{
									reference: emailReference,
									identifier: "EMAIL-2",
									status: "Todo",
								},
							],
						};
					} else {
						assert.ok(issued.has(args.reference));
						value =
							args.reference === reference
								? {
										disclosure: "identifier_status",
										issue: { identifier: "PRIVATE-1", status: "Todo" },
									}
								: {
										disclosure: "verified_customer_email",
										issue: {
											identifier: "EMAIL-2",
											status: "Todo",
											title: "Verified customer email subject",
											description: "Verified customer email body",
										},
									};
					}
					return {
						content: [],
						structuredContent: {
							items: [
								{
									grantId: grant.id,
									connectionId: grant.connectionId,
									accountId: grant.accountId,
									resource: grant.resource,
									text: JSON.stringify(value),
								},
							],
							nextCursor: null,
						},
					};
				},
			);
		}
		servers.push({ server, transport });
		await server.connect(transport);
	}
	reply.hijack();
	await transport.handleRequest(request.raw, reply.raw, request.body);
});
await app.listen({ host: "127.0.0.1", port: 0 });
const origin = app.server.address();
globalThis.fetch = async (url, init) => {
	assert.equal(String(url), "https://policy.fixture/mcp");
	const response = await originalFetch(
		`http://127.0.0.1:${origin.port}/mcp`,
		init,
	);
	const body =
		typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
	if (
		lostWrite &&
		effects.size === 1 &&
		body?.params?.name ===
			(workDetails ? "track_work" : "submit_engineering_request")
	) {
		lostWrite = false;
		await response.body?.cancel();
		throw Error("Lost committed submission ACK");
	}
	return response;
};
const model = await nativeOracle(
	{
		inspectRequest(request) {
			if (workDetails) {
				const tool = request.tools.find((t) => t.name === "track_work");
				assert.ok(tool);
				for (const name of ["waiting_reason", "waiting_on", "next_action"])
					assert.ok(JSON.stringify(tool.parameters).includes(name));
			}
			assert.ok(!JSON.stringify(request).includes("PRIVATE_PM_FINDING"));
			assert.ok(
				!request.tools.some((t) =>
					[
						"delegate_investigation",
						"execute",
						"publish_artifact",
						"reply",
					].includes(t.name),
				),
			);
		},
		next(messages) {
			const step = modelSteps++;
			if (workDetails) {
				if (step === 0)
					return {
						type: "tool",
						call: {
							name: "track_work",
							arguments: {
								reference: work.reference,
								status: "waiting",
								waiting_reason: "Need reproduction",
								waiting_on: "Customer",
								next_action: "Inspect supplied reproduction",
							},
						},
					};
				if (step === 1) {
					assert.ok(
						JSON.stringify(messages).includes("Need reproduction"),
						"Fresh recovery context contains saved waiting details",
					);
					return {
						type: "tool",
						call: {
							name: "track_work",
							arguments: {
								reference: work.reference,
								status: "active",
								waiting_reason: null,
								waiting_on: null,
							},
						},
					};
				}
				if (step === 2)
					return {
						type: "tool",
						call: { name: "read_context", arguments: {} },
					};
				const last = messages.at(-1);
				assert.ok(
					JSON.stringify(last).includes("Inspect supplied reproduction"),
				);
				assert.ok(!JSON.stringify(last).includes("waiting_reason"));
				assert.ok(!JSON.stringify(last).includes("waiting_on"));
				return {
					type: "result",
					text: "Waiting details updated; no schedule created.",
				};
			}
			if (step === 0)
				return { type: "tool", call: { name: "list_issues", arguments: {} } };
			if (step === 1)
				return {
					type: "tool",
					call: { name: "get_issue", arguments: { reference } },
				};
			if (step === 2) {
				assert.ok(JSON.stringify(messages).includes("identifier_status"));
				return {
					type: "tool",
					call: { name: "get_issue", arguments: { reference: emailReference } },
				};
			}
			if (step === 3)
				return {
					type: "tool",
					call: {
						name: "submit_engineering_request",
						arguments: {
							request: "Investigate the customer request",
							reference,
						},
					},
				};
			assert.ok(
				JSON.stringify(messages).includes("submit_engineering_request"),
			);
			assert.ok(JSON.stringify(messages).includes("accepted"));
			assert.ok(
				!JSON.stringify(messages).includes("Verified customer email body"),
				"Recovered transcript must be freshly filtered",
			);
			return {
				type: "result",
				text: "Request accepted by the workspace PM; no result return is implied.",
			};
		},
	},
	{
		directory: home,
		modules: join(edge, "automations"),
		load,
		codexDist: codex,
	},
);
const options = {
	workspaceId: () => "workspace",
	ledger,
	store,
	readiness: () => ({ ...definition.target, reason: null }),
	renewMilliseconds: 100000,
	model,
	sessions: {
		directory: join(home, "journal"),
		secrets: () => ["synthetic-scoped-token-for-policy-fixture-only"],
		transport: {
			deliver: async (e) => {
				const key = `${e.item.sessionId}:${e.item.sequence}`,
					digest = sessionDeliveryDigest(e.item);
				if (receipts.has(key)) assert.equal(receipts.get(key), digest);
				receipts.set(key, digest);
				return {
					contractVersion: 1,
					sessionId: e.item.sessionId,
					sequence: e.item.sequence,
					digest,
				};
			},
		},
	},
	tools: (authority, credential, signal) =>
		new ScopedAutomationMcpClient(
			"https://policy.fixture",
			authority,
			credential,
			signal,
		),
	gateway: {
		call: async (endpoint, body) => {
			if (endpoint === "authorize") {
				const a = {
					authority: {
						contractVersion: 1,
						definition: { ...definition, grants: workDetails ? [] : [grant] },
						occurrenceId: body.occurrence.id,
						input: body.occurrence.input,
						attemptId: body.attemptId,
						fence: body.fence,
						leaseUntil: new Date(Date.now() + 60000).toISOString(),
						phase: results.has(body.occurrence.id) ? "reconcile" : "execute",
					},
					customerPolicy: policy,
					...(!workDetails ? { oneWayEngineering: true } : {}),
					nativeContext: context,
					mcp: {
						token: "synthetic-scoped-token-for-policy-fixture-only",
						audience: "/mcp",
						grantId: grant.id,
						expiresAt: new Date(Date.now() + 55000).toISOString(),
					},
					sessionDeliveryAuthority: "current-admission-v1",
					sessionDelivery: {
						contractVersion: 1,
						path: "/api/agent-sessions/v1/deliver",
						session: {
							id: `customer:${body.occurrence.id}`,
							scopeRef: definition.scopeRef,
							role: "coordinator",
						},
					},
				};
				latest = executionAuthority(a);
				return a;
			}
			if (endpoint === "result") {
				resultTransmissions++;
				results.add(body.occurrenceId);
				if (lostResult) {
					lostResult = false;
					throw Error("Lost terminal ACK");
				}
				return {
					contractVersion: 1,
					occurrenceId: body.occurrenceId,
					idempotencyKey: body.idempotencyKey,
					acknowledged: true,
				};
			}
			return {};
		},
	},
};
const runtimes = [];
const run = async () => {
	const r = new AutomationRuntime(options);
	runtimes.push(r);
	await r.wake();
	await r.stop();
};
try {
	await run();
	assert.equal(
		effects.size,
		1,
		JSON.stringify({ status: ledger.status(definition.id), modelSteps }),
	);
	assert.equal(results.size, 0);
	assert.equal(modelSteps, workDetails ? 1 : 4);
	clock += 11000;
	await run();
	assert.equal(
		effects.size,
		workDetails ? 2 : 1,
		JSON.stringify({ status: ledger.status(definition.id), modelSteps }),
	);
	assert.equal(results.size, 1);
	assert.equal(modelSteps, workDetails ? 4 : 5);
	policy = { ...policy, epoch: randomUUID() };
	clock += 11000;
	await run();
	assert.equal(
		ledger.status(definition.id).occurrences.find((o) => o.id === occurrence.id)
			.status,
		"completed",
	);
	assert.equal(modelSteps, workDetails ? 4 : 5);
	assert.equal(resultTransmissions, 2);
	const summary = {
		passed: true,
		modelSteps,
		...(workDetails
			? {
					workUpdates: effects.size,
					omittedPreservedAndNullCleared: true,
					freshWorkDetailsTranscript: true,
				}
			: { oneWaySubmissions: effects.size }),
		resultCommits: results.size,
		resultTransmissions,
		privateActivityReceipts: receipts.size,
		...(workDetails
			? { lostWorkUpdateAck: true }
			: {
					strictRestrictedAndEmailRead: true,
					lostReferencedSubmissionAck: true,
				}),
		freshTranscript: true,
		changedEpochTerminalRecovery: true,
		limits: [
			"Actual isolated native Codex, MCP SDK HTTP, runtime and private SQLite",
			"Controlled model/Hosted/provider authority; no actual Hosted SQL or live-provider claim",
		],
	};
	if (process.env.CYRUS_F1_OUTPUT)
		await writeFile(
			process.env.CYRUS_F1_OUTPUT,
			JSON.stringify(summary, null, 2),
		);
	console.log(JSON.stringify(summary));
} finally {
	for (const r of runtimes) await r.stop();
	ledger.close();
	for (const s of servers) {
		await s.server.close();
		await s.transport.close();
	}
	await app.close();
	globalThis.fetch = originalFetch;
	await rm(home, { recursive: true, force: true });
}
