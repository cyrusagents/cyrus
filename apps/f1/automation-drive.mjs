// Controlled transports only. Production runtime, SQLite, Messages adapter and MCP SDK.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { AutomationRuntime } from "../../packages/edge-worker/dist/automations/AutomationRuntime.js";
import { AutomationCheckpointStore } from "../../packages/edge-worker/dist/automations/CheckpointStore.js";
import {
	authorizeTool,
	digest,
	permittedToolNames,
	scopedToolSchemas,
	toolCallSchema,
} from "../../packages/edge-worker/dist/automations/contract.js";
import { AutomationHttpGateway } from "../../packages/edge-worker/dist/automations/Gateway.js";
import { AutomationLedger } from "../../packages/edge-worker/dist/automations/Ledger.js";
import { ConfiguredAutomationMessagesModel } from "../../packages/edge-worker/dist/automations/Model.js";
import { registerAutomationRoutes } from "../../packages/edge-worker/dist/automations/register.js";
import { ScopedAutomationMcpClient } from "../../packages/edge-worker/dist/automations/ScopedMcpClient.js";
import { DockerSandbox } from "../../packages/edge-worker/dist/customer-runtime/DockerSandbox.js";

import { HttpSessionDeliveryTransport } from "../../packages/edge-worker/dist/sinks/SessionDeliveryTransport.js";
import {
	parseSessionDeliveryEnvelope,
	sessionDeliveryDigest,
} from "../../packages/edge-worker/dist/sinks/session-delivery.js";

const require = createRequire(
	new URL("../../packages/edge-worker/package.json", import.meta.url),
);
const Fastify = require("fastify");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const {
	StreamableHTTPServerTransport,
} = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const supervisorKey = "f1-supervisor-not-a-live-credential";
const modelKey = "f1-model-not-a-live-credential";

async function until(predicate, timeout = 10000) {
	const end = Date.now() + timeout;
	while (!predicate()) {
		if (Date.now() > end) throw new Error("F1 condition timed out");
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}
export async function runAutomationDrive({
	codexImage = process.env.CYRUS_F1_CODEX_IMAGE,
} = {}) {
	const target = codexImage
		? { harness: "codex", model: "gpt-5.5" }
		: { harness: "claude", model: "claude-fixture" };
	const directory = await mkdtemp(join(tmpdir(), "cyrus-automation-f1-"));
	const checkpoints = join(directory, "checkpoints");
	const definitions = new Map(),
		grants = new Map(),
		sessions = new Map(),
		results = new Map(),
		operationReceipts = new Map();
	const activityReceipts = new Map();
	const delegatedChildren = new Map();
	const engineeringAssignments = new Map();
	const engineeringPublications = new Map();
	const engineeringReceiptId = randomUUID();
	const readSetCustomerId = randomUUID();
	const readSetReferences = new Map();
	let readSetRotated = false;
	let sessionRenewals = 0;
	const measuredCompletions = new Map();
	let diagnosticRecovered = false;
	let readSetContentReads = 0;
	let delayedActivityEntered = false;
	let delayedModelComplete = false;
	let delayedActivityReleased = false;
	let releaseDelayedActivity;
	const delayedActivityGate = new Promise((resolve) => {
		releaseDelayedActivity = () => {
			delayedActivityReleased = true;
			resolve();
		};
	});
	let engineeringCalls = 0;
	let lostEngineeringAck = false;
	let lostDelegationAck = false;
	let delegationCalls = 0;
	let lostActivityAck = false;
	const counts = {
		sessionDeliveries: 0,
		initialize: 0,
		list: 0,
		tools: 0,
		models: 0,
		progress: 0,
		resultTransmissions: 0,
		resultCommits: 0,
		denied: 0,
	};
	let owner,
		lostAck = false;
	let holdEventModel = false,
		eventModelStarted = false;
	let releaseEventModel;
	const eventModelGate = new Promise((resolve) => {
		releaseEventModel = resolve;
	});
	const app = Fastify({ logger: false });
	function definition(
		id,
		namespace,
		provider = "linear",
		workspaceId = "workspace-a",
		schedule = null,
	) {
		const d = {
			id,
			workspaceId,
			ownerId: "operator",
			namespace,
			scopeRef: `binding-${id}`,
			revision: 1,
			state: "enabled",
			role: "coordinator",
			instruction: `Read the assigned ${provider} resource then report findings.`,
			schedule,
			target,
		};
		definitions.set(id, d);
		return d;
	}
	function denied(reply, status = 403) {
		counts.denied++;
		return reply.code(status).send({ error: "Denied" });
	}
	app.post("/api/automations/v1/:operation", async (request, reply) => {
		if (
			request.headers.authorization !== `Bearer ${supervisorKey}` ||
			request.headers["x-cyrus-team-id"] !== "workspace-a"
		)
			return denied(reply, 401);
		const b = request.body,
			d =
				results.get(b.occurrenceId)?.definition ??
				definitions.get(b.automationId);
		if (
			!d ||
			d.state !== "enabled" ||
			d.revision !== b.revision ||
			!b.instanceId
		)
			return denied(reply);
		if (owner && owner.id !== b.instanceId && owner.until > Date.now())
			return denied(reply);
		owner = { id: b.instanceId, until: Date.now() + 90000 };
		if (request.params.operation === "authorize") {
			if (d.id === "diagnostic-denial" && !diagnosticRecovered)
				return reply
					.code(403)
					.send({ error: "private response must not be persisted" });
			if (
				digest(b.definition) !== digest(d) ||
				b.occurrenceId !== b.occurrence.id
			)
				return denied(reply);
			const previous = [...grants.values()].find(
				(g) => g.authority.occurrenceId === b.occurrenceId && !g.revoked,
			);
			if (
				previous &&
				previous.authority.attemptId !== b.attemptId &&
				previous.until > Date.now()
			)
				return denied(reply);
			const provider = d.instruction.includes("slack") ? "slack" : "linear";
			const resource = d.id.startsWith("read-set-")
				? { provider: "linear", customerId: readSetCustomerId }
				: provider === "linear"
					? { provider, teamId: "team-a", issueId: `issue-${d.namespace}` }
					: { provider, channelId: "channel-a", threadTs: "123.456" };
			const resourceGrant = {
				id: `grant-${b.occurrenceId}`,
				connectionId: `connected-${provider}`,
				accountId: "installed-account",
				resource,
				permissions:
					d.id.startsWith("delegate-") &&
					request.headers["x-cyrus-delegation"] === "1" &&
					request.headers["x-cyrus-session-delivery"] === "1"
						? ["read", "delegate"]
						: ["read"],
			};
			const engineering = engineeringAssignments.get(d.id);
			if (
				engineering &&
				(request.headers["x-cyrus-engineering"] !== "1" ||
					request.headers["x-cyrus-session-delivery"] !== "1")
			)
				return denied(reply);
			if (d.id.startsWith("read-set-"))
				assert.equal(request.headers["x-cyrus-customer-read-set"], "1");
			const authority = {
				contractVersion: 1,
				definition: {
					...d,
					grants: engineering || d.id === "source-free" ? [] : [resourceGrant],
				},
				occurrenceId: b.occurrenceId,
				attemptId: b.attemptId,
				fence: b.fence,
				leaseUntil: new Date(
					Date.now() + (d.id === "read-set-rotate" ? 21000 : 90000),
				).toISOString(),
				phase: results.has(b.occurrenceId) ? "reconcile" : "execute",
				input: b.occurrence.input,
			};
			const grantId = resourceGrant.id,
				token = `fixture-${randomUUID()}-${randomUUID()}`,
				until = Date.now() + (d.id === "read-set-rotate" ? 20000 : 60000);
			const retainSession =
				d.id === "read-set-rotate" &&
				request.headers["x-cyrus-mcp-session-renewal"] === "1";
			if (b.mcpSessionId) {
				const session = sessions.get(b.mcpSessionId);
				assert.ok(
					retainSession &&
						b.phase === "renew" &&
						previous &&
						previous.until > Date.now(),
				);
				assert.equal(previous.authority.attemptId, b.attemptId);
				assert.equal(previous.authority.fence, b.fence);
				assert.equal(session?.grantId, grantId);
				assert.equal(grants.get(session.token), previous);
				session.token = token;
				sessionRenewals++;
			}
			if (previous) previous.revoked = true;
			grants.set(token, {
				authority: { ...authority, ...(engineering && { engineering }) },
				grantId,
				until,
				instanceId: b.instanceId,
				revoked: false,
			});
			const timing = [
				"read-set-normal",
				"read-set-rotate",
				"lost-ack",
				"source-free",
			].includes(d.id);
			if (timing)
				assert.equal(request.headers["x-cyrus-session-execution-timing"], "1");
			return {
				authority,
				...(timing && { sessionExecutionTiming: true }),
				...(engineering && { engineering }),
				...(request.headers["x-cyrus-session-delivery"] === "1" && {
					sessionDelivery: {
						contractVersion: 1,
						path: "/api/agent-sessions/v1/deliver",
						session: d.session ?? {
							id: `automation:${d.id}:${b.occurrenceId}`,
							scopeRef: d.scopeRef,
							role: d.role,
						},
					},
				}),
				mcp: {
					token,
					audience: "/mcp",
					expiresAt: new Date(until).toISOString(),
					grantId,
					...(retainSession && { sessionRenewal: true }),
					...(b.mcpSessionId && { sessionId: b.mcpSessionId }),
				},
			};
		}
		if (request.params.operation === "progress") {
			counts.progress++;
			return { ok: true };
		}
		if (request.params.operation === "result") {
			counts.resultTransmissions++;
			const sessionItems = [...activityReceipts.values()].filter(
				(entry) =>
					entry.item.sessionId ===
					(d.session?.id ?? `automation:${d.id}:${b.occurrenceId}`),
			);
			assert.equal(
				sessionItems.length,
				d.id.startsWith("read-set-")
					? codexImage
						? 11
						: 10
					: engineeringAssignments.has(d.id)
						? 11
						: d.id === "source-free"
							? codexImage
								? 5
								: 4
							: codexImage
								? 7
								: 6,
			);
			assert.equal(sessionItems.at(-1).item.payload.status, "complete");
			const measurement = sessionItems.at(-1).item.payload;
			if (
				[
					"read-set-normal",
					"read-set-rotate",
					"lost-ack",
					"source-free",
				].includes(d.id)
			) {
				assert.equal(measurement.executionDurationComplete, true);
				assert.ok(
					Number.isSafeInteger(measurement.executionDurationMs) &&
						measurement.executionDurationMs >= 0,
				);
				if (d.id === "read-set-rotate")
					assert.ok(
						measurement.executionDurationMs >= 50000,
						"both actual slow model calls are measured",
					);
				if (measuredCompletions.has(b.occurrenceId))
					assert.equal(
						measuredCompletions.get(b.occurrenceId).durationMs,
						measurement.executionDurationMs,
						"result-only recovery never adds time",
					);
				measuredCompletions.set(b.occurrenceId, {
					automationId: d.id,
					durationMs: measurement.executionDurationMs,
				});
			} else assert.equal(measurement.executionDurationMs, undefined);

			const previous = results.get(b.occurrenceId);
			if (previous) assert.equal(previous.key, b.idempotencyKey);
			else {
				results.set(b.occurrenceId, {
					key: b.idempotencyKey,
					text: b.text,
					definition: d,
				});
				counts.resultCommits++;
				await writeFile(
					join(directory, "results.json"),
					JSON.stringify([...results.values()]),
					{ mode: 0o600 },
				);
			}
			if (d.id === "lost-ack" && !lostAck) {
				lostAck = true;
				return reply.code(503).send({ error: "Controlled lost ACK" });
			}
			return {
				contractVersion: 1,
				acknowledged: true,
				occurrenceId: b.occurrenceId,
				idempotencyKey: b.idempotencyKey,
			};
		}
		return denied(reply);
	});
	app.post("/api/agent-sessions/v1/deliver", async (request, reply) => {
		if (
			request.headers.authorization !== `Bearer ${supervisorKey}` ||
			request.headers["x-cyrus-team-id"] !== "workspace-a"
		)
			return denied(reply, 401);
		const envelope = parseSessionDeliveryEnvelope(request.body);
		const current = [...grants.values()].find(
			(g) =>
				!g.revoked &&
				g.until > Date.now() &&
				g.instanceId === envelope.instanceId &&
				g.authority.occurrenceId === envelope.occurrenceId &&
				g.authority.attemptId === envelope.attemptId &&
				g.authority.fence === envelope.fence,
		);
		if (!current) return denied(reply);
		const d = current.authority.definition;
		const item = envelope.item;
		assert.equal(
			item.sessionId,
			d.session?.id ?? `automation:${d.id}:${envelope.occurrenceId}`,
		);
		if (item.kind === "session")
			assert.deepEqual(
				item.payload,
				d.session ?? {
					id: item.sessionId,
					scopeRef: d.scopeRef,
					role: d.role,
				},
			);
		if (d.id === "read-set-normal" && item.sequence === 2) {
			delayedActivityEntered = true;
			await delayedActivityGate;
		}
		const key = `${item.sessionId}:${item.sequence}`,
			hash = sessionDeliveryDigest(item);
		const previous = activityReceipts.get(key);
		if (previous) assert.equal(previous.digest, hash);
		else {
			assert.equal(results.has(envelope.occurrenceId), false);
			assert.equal(
				item.sequence,
				[...activityReceipts.values()].filter(
					(e) => e.item.sessionId === item.sessionId,
				).length + 1,
			);
			activityReceipts.set(key, { item, digest: hash });
		}
		counts.sessionDeliveries++;
		if (
			!lostActivityAck &&
			item.kind === "activity" &&
			item.payload.content.type === "response"
		) {
			lostActivityAck = true;
			return reply.code(503).send({ error: "Controlled lost activity ACK" });
		}
		return {
			contractVersion: 1,
			sessionId: item.sessionId,
			sequence: item.sequence,
			digest: hash,
		};
	});
	app.post("/model", async (request) => {
		counts.models++;
		assert.equal(
			codexImage ? request.headers.authorization : request.headers["x-api-key"],
			codexImage ? `Bearer ${modelKey}` : modelKey,
		);
		const text = JSON.stringify(request.body);
		if (holdEventModel && text.includes("event-live-slack")) {
			eventModelStarted = true;
			await eventModelGate;
		}
		assert.ok(
			["event-live-slack", "event-late-slack", "event-live-linear"].filter(
				(marker) => text.includes(marker),
			).length <= 1,
		);
		assert.ok(!text.includes(supervisorKey));
		assert.ok(!text.includes('"token"'));
		assert.ok(!text.includes('"grantId"'));
		const tracking = text.includes("delegate-direct")
			? "direct"
			: text.includes("delegate-ticket")
				? "assigned_ticket"
				: null;
		const outputs = codexImage
			? request.body.input.filter((m) => m.type === "function_call_output")
					.length
			: request.body.messages.filter((m) => m.role === "assistant").length;
		const engineering = text.includes("Reviewed technical brief:");
		const readSet = text.includes("read-set-rotate")
			? "read-set-rotate"
			: text.includes("read-set-normal")
				? "read-set-normal"
				: null;
		const readSetReads = [0, 1].filter((i) =>
			text.includes(`Read-set issue body ${i}`),
		).length;
		const lastOutput = codexImage
			? request.body.input
					.filter((m) => m.type === "function_call_output")
					.at(-1)
			: request.body.messages.at(-1);
		const relist =
			readSet &&
			(outputs === 0 ||
				JSON.stringify(lastOutput).includes("Call list_issues"));
		if (readSet === "read-set-rotate" && outputs > 0 && outputs < 3) {
			readSetRotated = true;
			await new Promise((resolve) => setTimeout(resolve, 25000));
		}

		if (engineering && outputs === 1)
			assert.ok(
				text.includes("ERR_ASSERTION"),
				"native model receives ordinary failing-test diagnostics",
			);
		if (engineering && outputs === 2)
			assert.ok(
				text.includes("# pass 1"),
				"native model receives passing repair diagnostics",
			);
		const sourceFree = codexImage
			? request.body.tools.length === 0
			: request.body.system.includes("Available names: [].");
		const replied =
			sourceFree ||
			(readSet
				? readSetReads === 2
				: outputs >= (engineering ? 3 : tracking ? 2 : 1));
		if (readSet === "read-set-normal") {
			await new Promise((resolve) => setTimeout(resolve, 100));
			if (replied) delayedModelComplete = true;
		}
		const name = readSet
			? relist
				? "list_issues"
				: "get_issue"
			: engineering
				? outputs < 2
					? "execute"
					: "publish_artifact"
				: tracking
					? "delegate_investigation"
					: (
								codexImage
									? request.body.tools.some((t) => t.name === "read_messages")
									: request.body.system.includes(
											'Available names: ["read_messages"]',
										)
							)
						? "read_messages"
						: "get_issue";
		const toolArguments = readSet
			? relist || replied
				? {}
				: { reference: readSetReferences.get(readSet)[readSetReads] }
			: engineering
				? outputs === 0
					? { command: "printf retained > retained.txt; node --test" }
					: outputs === 1
						? {
								command:
									"printf 'exports.sum=(a,b)=>a+b;' > sum.cjs; node --test",
							}
						: {
								title: "Repair addition",
								summary: "Synthetic reproduction passes",
							}
				: tracking
					? {
							instruction: "Investigate the bound source and return findings",
							tracking,
						}
					: {};
		if (readSet && !relist && !replied)
			assert.ok(
				text.includes(toolArguments.reference),
				"model uses only a reference in its received conversation",
			);
		if (codexImage) {
			const item = replied
				? {
						type: "message",
						id: "msg_fixture",
						role: "assistant",
						content: [
							{
								type: "output_text",
								text: "Verified assigned resource. No customer effect performed.",
								annotations: [],
							},
						],
						status: "completed",
					}
				: {
						type: "function_call",
						id: "fc_fixture",
						call_id: `call_fixture_${outputs}`,
						name,
						arguments: JSON.stringify(toolArguments),
					};
			const response = {
				id: "resp_fixture",
				object: "response",
				status: "completed",
				output: [item],
				usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
			};
			return [
				[
					"response.created",
					{ response: { ...response, status: "in_progress", output: [] } },
				],
				["response.output_item.added", { output_index: 0, item }],
				["response.output_item.done", { output_index: 0, item }],
				["response.completed", { response }],
			]
				.map(
					([type, data]) =>
						`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`,
				)
				.join("");
		}
		return {
			content: [
				{
					type: "text",
					text: JSON.stringify(
						replied
							? {
									type: "result",
									text: "Verified assigned resource. No customer effect performed.",
								}
							: { type: "tool", call: { name, arguments: toolArguments } },
					),
				},
			],
		};
	});
	app.all("/mcp", async (request, reply) => {
		if (request.method === "GET")
			return reply.code(405).send({ error: "Streaming unavailable" });
		const token = request.headers.authorization?.replace(/^Bearer /, "");
		const grant = grants.get(token);
		if (
			!grant ||
			grant.revoked ||
			grant.until <= Date.now() ||
			owner?.id !== grant.instanceId ||
			results.has(grant.authority.occurrenceId)
		)
			return denied(reply, 401);
		const d = definitions.get(grant.authority.definition.id);
		if (
			!d ||
			d.state !== "enabled" ||
			d.revision !== grant.authority.definition.revision
		)
			return denied(reply, 401);
		const sessionId = request.headers["mcp-session-id"];
		let session = sessionId && sessions.get(sessionId);
		if (
			sessionId &&
			(!session || session.grantId !== grant.grantId || session.token !== token)
		)
			return denied(reply, 404);
		if (!session) {
			if (request.body?.method !== "initialize") return denied(reply);
			counts.initialize++;
			const server = new McpServer({
				name: "f1-scoped-hosted-mcp",
				version: "1",
			});
			const transport = new StreamableHTTPServerTransport({
				sessionIdGenerator: randomUUID,
				enableJsonResponse: true,
				onsessioninitialized: (id) => sessions.set(id, session),
			});
			session = { server, transport, grantId: grant.grantId, token };
			const issuedReferences = new Map();
			for (const name of permittedToolNames(grant.authority).filter(
				(name) => name !== "execute",
			)) {
				const schema = scopedToolSchemas(grant.authority).find(
					(schema) => schema.shape.name.value === name,
				).shape.arguments;
				server.registerTool(
					name,
					{ inputSchema: schema },
					async (args, extra) => {
						authorizeTool(grant.authority, { name, arguments: args });
						const key = extra._meta?.idempotencyKey;
						assert.match(key, /^[a-f0-9]{64}$/);
						const payload = digest({ name, args });
						if (operationReceipts.has(key))
							assert.equal(operationReceipts.get(key), payload);
						else {
							operationReceipts.set(key, payload);
							counts.tools++;
						}
						if (name === "delegate_investigation") {
							delegationCalls++;
							if (!delegatedChildren.has(key)) {
								const child = definition(
									`admitted-child-${randomUUID()}`,
									d.namespace,
								);
								child.role = "investigator";
								child.instruction = args.instruction;
								child.session = {
									id: `assignment:${randomUUID()}`,
									parentSessionId: `automation:${d.id}:${grant.authority.occurrenceId}`,
									scopeRef: child.scopeRef,
									role: child.role,
									...(args.tracking === "assigned_ticket" && {
										issueContext: {
											trackerId: "linear",
											issueId:
												grant.authority.definition.grants[0].resource.issueId,
											issueIdentifier: "F1-DELEGATED",
										},
									}),
								};
								for (const [path, body] of [
									["definitions", { contractVersion: 1, definition: child }],
									[
										"occurrences",
										{
											contractVersion: 1,
											automationId: child.id,
											revision: 1,
											eventId: key,
											input: args.instruction,
										},
									],
								]) {
									const response = await realFetch(
										`${runtimeOrigin}/api/automations/v1/${path}`,
										{
											method: "POST",
											headers: {
												Authorization: `Bearer ${supervisorKey}`,
												"Content-Type": "application/json",
											},
											body: JSON.stringify(body),
										},
									);
									assert.equal(response.status, 200);
								}
								delegatedChildren.set(key, child);
							}
							if (!lostDelegationAck) {
								lostDelegationAck = true;
								grant.revoked = true;
								grant.until = 0;
								throw new Error("Controlled lost delegation ACK");
							}
						}
						if (name === "publish_artifact") {
							engineeringCalls++;
							const files = extra._meta.engineeringFiles;
							assert.equal(files["sum.cjs"], "exports.sum=(a,b)=>a+b;");
							assert.equal(files["retained.txt"], "retained");
							const hash = digest({ args, files });
							if (engineeringPublications.has(key))
								assert.equal(engineeringPublications.get(key), hash);
							else engineeringPublications.set(key, hash);
							if (!lostEngineeringAck) {
								lostEngineeringAck = true;
								grant.revoked = true;
								grant.until = 0;
								throw Error("Controlled lost engineering ACK");
							}
							return {
								content: [],
								structuredContent: {
									assignmentId: grant.authority.engineering.assignmentId,
									status: "published",
									receiptId: engineeringReceiptId,
									publication: {
										repository: grant.authority.engineering.repository,
										number: 1,
										url: `https://github.com/${grant.authority.engineering.repository}/pull/1`,
										headSha: "b".repeat(40),
									},
								},
							};
						}
						const g = grant.authority.definition.grants[0];
						if (d.id.startsWith("read-set-")) {
							let text;
							if (name === "list_issues") {
								const issues = [0, 1].map((i) => {
									const reference = randomUUID();
									issuedReferences.set(reference, i);
									return { reference, identifier: `FIX-${i + 1}` };
								});
								readSetReferences.set(
									d.id,
									issues.map((i) => i.reference),
								);
								text = JSON.stringify({ issues, held: 1 });
							} else {
								assert.ok(
									issuedReferences.has(args.reference),
									"reference belongs to this exact session",
								);
								if (d.id === "read-set-normal")
									await new Promise((resolve) => setTimeout(resolve, 200));
								readSetContentReads++;
								text = `Read-set issue body ${issuedReferences.get(args.reference)}`;
							}
							return {
								content: [],
								structuredContent: {
									items: [
										{
											grantId: grant.grantId,
											connectionId: g.connectionId,
											accountId: g.accountId,
											resource: g.resource,
											text,
										},
									],
									nextCursor: null,
								},
							};
						}
						const structuredContent = {
							items: [
								{
									grantId: grant.grantId,
									connectionId: g.connectionId,
									accountId: g.accountId,
									resource: g.resource,
									text: `Private result for ${d.namespace}`,
								},
							],
							nextCursor: null,
						};
						return {
							content: [
								{ type: "text", text: JSON.stringify(structuredContent) },
							],
							structuredContent,
						};
					},
				);
			}
			await server.connect(transport);
		}
		if (request.body?.method === "tools/list") counts.list++;
		if (
			request.body?.method === "tools/call" &&
			!toolCallSchema.safeParse(
				request.body.params && {
					name: request.body.params.name,
					arguments: request.body.params.arguments,
				},
			).success
		)
			return denied(reply);
		reply.hijack();
		await session.transport.handleRequest(request.raw, reply.raw, request.body);
	});
	await app.listen({ host: "127.0.0.1", port: 0 });
	const origin = `http://127.0.0.1:${app.server.address().port}`;
	const realFetch = globalThis.fetch;
	globalThis.fetch = async (url, options) => {
		const value = String(url);
		if (value.startsWith("https://automation.fixture/"))
			return realFetch(
				value.replace("https://automation.fixture", origin),
				options,
			);
		if (
			value === "https://api.anthropic.com/v1/messages" ||
			value === "https://chatgpt.com/backend-api/codex/responses"
		)
			return realFetch(`${origin}/model`, options);
		if (value.startsWith(`${origin}/`)) return realFetch(url, options);
		throw new Error("F1 external network denied");
	};
	let nativeModel;
	if (codexImage) {
		const { ContainedCodexAutomationModel } = await import(
			"../../packages/edge-worker/dist/automations/ContainedCodexModel.js"
		);
		const { CodexLoginBroker } = await import(
			"../../packages/codex-runner/dist/index.js"
		);
		const authHome = join(directory, "fixture-codex-login");
		await mkdir(authHome, { mode: 0o700 });
		await writeFile(
			join(authHome, "auth.json"),
			JSON.stringify({
				auth_mode: "chatgpt",
				tokens: { access_token: modelKey, account_id: "fixture-account" },
			}),
			{ mode: 0o600 },
		);
		const broker = new CodexLoginBroker(authHome);
		nativeModel = new ContainedCodexAutomationModel(
			{
				image: codexImage,
				dockerPath:
					process.env.CYRUS_TEST_DOCKER_PATH || "/usr/local/bin/docker",
				dockerHost:
					process.env.CYRUS_TEST_DOCKER_HOST || "unix:///var/run/docker.sock",
			},
			(request, context) =>
				broker.respond(
					request,
					{
						model: target.model,
						scopeKey: context.state.scopeKey,
						toolNames: permittedToolNames(context.authority()),
						authorize: context.authorize,
					},
					context.signal,
				),
		);
	}
	let runtimeApp, runtime, runtimeOrigin;
	let modelEnabled = true;
	const ledger = new AutomationLedger(join(directory, "ledger"), "workspace-a");
	function makeRuntime() {
		runtime = new AutomationRuntime({
			workspaceId: () => "workspace-a",
			ledger,
			gateway: new AutomationHttpGateway(
				"https://automation.fixture",
				() => ({
					apiKey: supervisorKey,
					workspaceId: "workspace-a",
				}),
				true,
				() => !!codexImage,
			),
			...(codexImage && {
				engineering: {
					available: () => true,
					sandbox: () =>
						new DockerSandbox({
							image: codexImage,
							dockerPath:
								process.env.CYRUS_TEST_DOCKER_PATH || "/usr/local/bin/docker",
							dockerHost:
								process.env.CYRUS_TEST_DOCKER_HOST ||
								"unix:///var/run/docker.sock",
							javascriptRuntime: "node",
						}),
				},
			}),
			sessions: {
				directory: join(directory, "session-journal"),
				secrets: () => [supervisorKey, modelKey],
				transport: new HttpSessionDeliveryTransport(
					"https://automation.fixture",
					() => ({ workspaceId: "workspace-a", apiKey: supervisorKey }),
				),
			},
			model:
				nativeModel ||
				new ConfiguredAutomationMessagesModel(() => ({
					...target,
					apiKey: modelKey,
				})),
			store: new AutomationCheckpointStore(checkpoints),
			readiness: () => ({
				...target,
				reason: modelEnabled ? null : "Configured model unavailable",
				...(codexImage && { adapter: "codex-app-server-contained-v1" }),
			}),
			pollMilliseconds: 50,
			tools: (authority, credential, signal) =>
				new ScopedAutomationMcpClient(
					"https://automation.fixture",
					authority,
					credential,
					signal,
				),
		});
		runtimeApp = Fastify({ logger: false });
		registerAutomationRoutes(runtimeApp, runtime, () => supervisorKey);
		return runtimeApp;
	}
	try {
		runtimeOrigin = await makeRuntime().listen({ host: "127.0.0.1", port: 0 });
		const call = async (path, body, key = supervisorKey) => {
			const response = await realFetch(
				`${runtimeOrigin}/api/automations/v1/${path}`,
				{
					method: "POST",
					headers: {
						authorization: `Bearer ${key}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify(body),
				},
			);
			const result = await response.json();
			return { statusCode: response.status, json: () => result };
		};
		assert.equal(
			(await realFetch(`${runtimeOrigin}/api/automations/v1/capabilities`))
				.status,
			401,
		);
		const discovery = await realFetch(
			`${runtimeOrigin}/api/automations/v1/capabilities`,
			{
				headers: { authorization: `Bearer ${supervisorKey}` },
			},
		);
		assert.equal(discovery.status, 200);
		const capabilities = (await discovery.json()).capabilities;
		assert.equal(capabilities.customerReadSet, true);
		assert.equal(capabilities.operatorRecovery, true);
		assert.equal(
			(await call("wake", { contractVersion: 1, customerId: "evil" }))
				.statusCode,
			400,
		);
		assert.equal(
			(
				await call("definitions", {
					contractVersion: 1,
					definition: definition("foreign", "other", "linear", "workspace-b"),
				})
			).statusCode,
			409,
		);
		const manual = definition("operator-instruction", "customer-a"),
			tick = definition("scheduled", "customer-b", "slack", "workspace-a", {
				intervalSeconds: 60,
				anchorAt: new Date(Date.now() + 1500).toISOString(),
				timezone: "UTC",
			});
		for (const d of [manual, tick])
			assert.equal(
				(await call("definitions", { contractVersion: 1, definition: d }))
					.statusCode,
				200,
			);
		const event = {
			contractVersion: 1,
			automationId: manual.id,
			revision: 1,
			eventId: "operator-event-1",
			input: "Investigate assigned source",
		};
		const enqueued = await call("occurrences", event);
		assert.equal(enqueued.statusCode, 200);
		assert.equal(
			(await call("occurrences", event)).json().occurrenceId,
			enqueued.json().occurrenceId,
		);
		await until(() => counts.resultCommits === 2);
		assert.equal(ledger.status(manual.id).occurrences.length, 1);
		const visible = await realFetch(
			`${runtimeOrigin}/api/automations/v1/status/${manual.id}`,
			{ headers: { authorization: `Bearer ${supervisorKey}` } },
		);
		assert.equal(visible.status, 200);
		assert.equal((await visible.json()).occurrences.length, 1);
		await until(
			() => ledger.status(tick.id).occurrences[0]?.status === "completed",
		);
		assert.equal(counts.tools, 2);
		assert.equal(counts.models, 4);
		const generic = definition("general-automation", "non-customer-ops");
		await call("definitions", { contractVersion: 1, definition: generic });
		await call("occurrences", {
			...event,
			automationId: generic.id,
			eventId: "generic-event",
		});
		await until(() => counts.resultCommits === 3);
		const loss = definition("lost-ack", "customer-a");
		await call("definitions", { contractVersion: 1, definition: loss });
		await call("occurrences", {
			...event,
			automationId: loss.id,
			eventId: "ack-event",
		});
		await until(() => lostAck);
		const paused = { ...loss, revision: 2, state: "paused" };
		definitions.set(loss.id, paused);
		assert.equal(
			(await call("definitions", { contractVersion: 1, definition: paused }))
				.statusCode,
			200,
		);
		modelEnabled = false;
		const modelBefore = counts.models,
			progressBefore = counts.progress,
			toolsBefore = counts.tools;
		await runtimeApp.close();
		owner.until = 0;
		for (const grant of grants.values()) {
			grant.until = 0;
			grant.revoked = true;
		}
		runtimeOrigin = await makeRuntime().listen({ host: "127.0.0.1", port: 0 });
		await until(
			() => ledger.status(loss.id).occurrences[0]?.status === "completed",
			15000,
		);
		assert.equal(counts.resultCommits, 4);
		assert.equal(counts.resultTransmissions, 5);
		assert.equal(counts.models, modelBefore);
		assert.equal(counts.progress, progressBefore);
		assert.equal(counts.tools, toolsBefore);
		// The scheduled tick is already verified. Keep later slow-turn fixtures
		// independent of wall-clock tick count rather than racing aggregate totals.
		const pausedTick = {
			...tick,
			revision: tick.revision + 1,
			state: "paused",
		};
		definitions.set(tick.id, pausedTick);
		assert.equal(
			(
				await call("definitions", {
					contractVersion: 1,
					definition: pausedTick,
				})
			).statusCode,
			200,
		);
		modelEnabled = true;
		// Real connection/session tests, using an explicitly admitted fixture authority.
		const d = definition("session-probe", "probe");
		runtime.upsert(d);
		const o = runtime.enqueue(d.id, 1, "session", "probe");
		await runtime.stop();
		const [claimed] = ledger.claim(1);
		const boot = {
			contractVersion: 1,
			instanceId: owner.id,
			automationId: d.id,
			revision: 1,
			occurrenceId: o.id,
			attemptId: claimed.occurrence.attemptId,
			fence: claimed.occurrence.fence,
			definition: d,
			occurrence: {
				id: o.id,
				trigger: "instruction",
				scheduledAt: o.scheduledAt,
				input: o.input,
			},
			phase: "admit",
		};
		const authorize = async (body) =>
			realFetch(`${origin}/api/automations/v1/authorize`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${supervisorKey}`,
					"X-Cyrus-Team-Id": "workspace-a",
					"Content-Type": "application/json",
				},
				body: JSON.stringify(body),
			});
		assert.equal(
			(await authorize({ ...boot, definition: { ...d, role: "engineering" } }))
				.status,
			403,
		);
		assert.equal(
			(await authorize({ ...boot, instanceId: "copied-runtime" })).status,
			403,
		);
		const admission = await (await authorize(boot)).json();
		const probe = new ScopedAutomationMcpClient(
			"https://automation.fixture",
			() => admission.authority,
			() => admission.mcp,
			new AbortController().signal,
		);
		await probe.call(
			{ name: "get_issue", arguments: {} },
			digest("probe"),
			new AbortController().signal,
		);
		const before = counts.tools;
		for (const args of [
			{ issueId: "other" },
			{ grantId: "other-session" },
			{ resourceRef: "expired-reference" },
		])
			await assert.rejects(
				probe.call(
					{ name: "get_issue", arguments: args },
					digest(args),
					new AbortController().signal,
				),
			);
		await assert.rejects(
			probe.call(
				{ name: "search", arguments: {} },
				digest("search"),
				new AbortController().signal,
			),
		);
		grants.get(admission.mcp.token).revoked = true;
		await assert.rejects(
			probe.call(
				{ name: "get_issue", arguments: {} },
				digest("revoked"),
				new AbortController().signal,
			),
		);
		assert.equal(counts.tools, before);
		await probe.close();
		const renew = await (await authorize({ ...boot, phase: "renew" })).json();
		const reconnect = new ScopedAutomationMcpClient(
			"https://automation.fixture",
			() => renew.authority,
			() => renew.mcp,
			new AbortController().signal,
		);
		await reconnect.call(
			{ name: "get_issue", arguments: {} },
			digest("reconnect"),
			new AbortController().signal,
		);
		grants.get(renew.mcp.token).until = 0;
		await assert.rejects(
			reconnect.call(
				{ name: "get_issue", arguments: {} },
				digest("expired"),
				new AbortController().signal,
			),
		);
		await reconnect.close();
		ledger.finish(claimed.occurrence, true);
		assert.equal(
			(
				await realFetch(`${origin}/mcp`, {
					method: "POST",
					headers: {
						authorization: `Bearer ${supervisorKey}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						jsonrpc: "2.0",
						id: 1,
						method: "initialize",
						params: {},
					}),
				})
			).status,
			401,
		);
		// Signed-provider interpretation belongs to Hosted. These are already admitted
		// opaque inputs; exercise the generic HTTP queue while a model turn is active.
		await runtimeApp.close();
		owner.until = 0;
		runtimeOrigin = await makeRuntime().listen({ host: "127.0.0.1", port: 0 });
		const slackEvents = definition("slack-events", "event-customer-a", "slack");
		const linearEvents = definition("linear-events", "event-customer-b");
		for (const d of [slackEvents, linearEvents])
			await call("definitions", { contractVersion: 1, definition: d });
		const eventInput = (d, id, input) => ({
			contractVersion: 1,
			automationId: d.id,
			revision: 1,
			eventId: id,
			input,
			trigger: "event",
		});
		const eventBase = counts.resultCommits;
		holdEventModel = true;
		assert.equal(
			(
				await call(
					"occurrences",
					eventInput(slackEvents, "source-event-newer", "event-live-slack"),
				)
			).statusCode,
			200,
		);
		await until(() => eventModelStarted);
		const late = eventInput(
			slackEvents,
			"source-event-older",
			"event-late-slack",
		);
		const queued = await call("occurrences", late);
		assert.equal(queued.statusCode, 200);
		assert.equal(
			(await call("occurrences", late)).json().occurrenceId,
			queued.json().occurrenceId,
		);
		assert.equal(
			(await call("occurrences", { ...late, input: "changed" })).statusCode,
			409,
		);
		assert.deepEqual(
			ledger.status(slackEvents.id).occurrences.map((o) => o.status),
			["running", "queued"],
		);
		assert.equal(
			(
				await call(
					"occurrences",
					eventInput(linearEvents, "source-event-older", "event-live-linear"),
				)
			).statusCode,
			200,
		);
		await until(() => counts.resultCommits === eventBase + 1);
		await runtimeApp.close();
		holdEventModel = false;
		releaseEventModel();
		assert.equal(ledger.status(slackEvents.id).occurrences.length, 2);
		owner.until = 0;
		for (const g of grants.values()) {
			g.revoked = true;
			g.until = 0;
		}
		runtimeOrigin = await makeRuntime().listen({ host: "127.0.0.1", port: 0 });
		await until(
			() =>
				ledger
					.status(slackEvents.id)
					.occurrences.every((o) => o.status === "completed"),
			15000,
		);
		assert.equal(counts.resultCommits, eventBase + 3);
		for (const ticket of [false, true]) {
			const d = definition(
				ticket ? "ticket-child" : "direct-child",
				"customer-a",
			);
			d.role = "investigator";
			d.session = {
				id: `assignment:${randomUUID()}`,
				parentSessionId: `automation:${manual.id}:${enqueued.json().occurrenceId}`,
				scopeRef: d.scopeRef,
				role: d.role,
				...(ticket && {
					issueContext: {
						trackerId: "linear",
						issueId: "fixture-assigned-issue",
						issueIdentifier: "F1-1",
					},
				}),
			};
			assert.ok(
				[...activityReceipts.values()].some(
					(e) =>
						e.item.sessionId === d.session.parentSessionId &&
						e.item.kind === "session",
				),
			);
			assert.equal(
				(await call("definitions", { contractVersion: 1, definition: d }))
					.statusCode,
				200,
			);
			const count = counts.resultCommits;
			await call("occurrences", {
				...event,
				automationId: d.id,
				eventId: d.id,
			});
			await until(() => counts.resultCommits === count + 1);
			const received = [...activityReceipts.values()].filter(
				(e) => e.item.sessionId === d.session.id,
			);
			assert.deepEqual(received[0].item.payload, d.session);
			assert.equal(received.at(-1).item.payload.status, "complete");
			assert.equal(received[0].item.payload.externalSessionId, undefined);
		}
		for (const tracking of ["direct", "ticket"]) {
			const parent = definition(`delegate-${tracking}`, "customer-a");
			parent.instruction = `delegate-${tracking}: investigate the bound resource`;
			await call("definitions", { contractVersion: 1, definition: parent });
			const before = counts.resultCommits;
			await call("occurrences", {
				...event,
				automationId: parent.id,
				eventId: parent.id,
			});
			await until(() => counts.resultCommits === before + 2, 25000);
			const children = [...delegatedChildren.values()].filter((child) =>
				child.session.parentSessionId.startsWith(`automation:${parent.id}:`),
			);
			assert.equal(
				children.length,
				1,
				"replayed delegation creates exactly one child",
			);
			const child = children[0];
			assert.equal(!!child.session.issueContext, tracking === "ticket");
			await until(
				() =>
					ledger.status(child.id).occurrences[0].status === "completed" &&
					ledger.status(parent.id).occurrences[0].status === "completed",
			);
			assert.equal(ledger.status(child.id).occurrences[0].status, "completed");
			const received = [...activityReceipts.values()].filter(
				(e) => e.item.sessionId === child.session.id,
			);
			assert.deepEqual(received[0].item.payload, child.session);
			assert.equal(received.at(-1).item.payload.status, "complete");
		}
		assert.equal(delegatedChildren.size, 2);
		assert.equal(
			delegationCalls,
			5,
			"lost ACK plus repeated payloads reconcile the same two assignments",
		);
		assert.equal(lostDelegationAck, true);

		{
			const d = definition("diagnostic-denial", "diagnostic-scope");
			const before = { models: counts.models, initialize: counts.initialize };
			await call("definitions", { contractVersion: 1, definition: d });
			await call("occurrences", {
				...event,
				automationId: d.id,
				eventId: "diagnostic-event",
				input: "private diagnostic input",
			});
			await until(
				() => ledger.status(d.id).occurrences[0]?.status === "blocked",
				25000,
			);
			const response = await realFetch(
				`${runtimeOrigin}/api/automations/v1/status/${d.id}`,
				{ headers: { authorization: `Bearer ${supervisorKey}` } },
			);
			assert.equal(response.status, 200);
			const blocked = (await response.json()).occurrences[0];
			assert.equal(blocked.attempts, 3);
			assert.deepEqual(
				{ ...blocked.lastFailure, at: undefined },
				{
					phase: "authorize",
					authorizePhase: "admit",
					code: "http_denied",
					httpStatus: 403,
					at: undefined,
				},
			);
			assert.ok(Number.isFinite(Date.parse(blocked.lastFailure.at)));
			assert.deepEqual(
				blocked.failureHistory.map(({ attempt, fence, authorizePhase }) => ({
					attempt,
					fence,
					authorizePhase,
				})),
				[1, 2, 3].map((attempt) => ({
					attempt,
					fence: attempt,
					authorizePhase: "admit",
				})),
			);
			assert.equal(
				JSON.stringify(blocked.lastFailure).includes("private"),
				false,
			);
			assert.equal(counts.models, before.models);
			assert.equal(counts.initialize, before.initialize);
			assert.equal(
				(await realFetch(`${runtimeOrigin}/api/automations/v1/status/${d.id}`))
					.status,
				401,
			);
			const command = {
				contractVersion: 1,
				workspaceId: "workspace-a",
				automationId: d.id,
				revision: d.revision,
				occurrenceId: blocked.id,
				commandId: randomUUID(),
				expectedFence: blocked.fence,
			};
			assert.equal((await call("retry", command, "wrong-key")).statusCode, 401);
			assert.equal(
				(await call("retry", { ...command, input: "replacement" })).statusCode,
				400,
			);
			for (const patch of [
				{ workspaceId: "workspace-b" },
				{ revision: 2 },
				{ expectedFence: 2 },
				{ occurrenceId: "a".repeat(64) },
			])
				assert.equal(
					(await call("retry", { ...command, ...patch })).statusCode,
					409,
				);
			const accepted = await call("retry", command);
			assert.equal(accepted.statusCode, 202);
			const replay = await call("retry", command);
			assert.equal(replay.statusCode, 202);
			assert.deepEqual(replay.json(), accepted.json());
			assert.equal(
				(await call("retry", { ...command, commandId: randomUUID() }))
					.statusCode,
				409,
			);
			await until(
				() => ledger.status(d.id).occurrences[0].status === "blocked",
				25000,
			);
			const deniedAgain = ledger.status(d.id).occurrences[0];
			assert.equal(deniedAgain.attempts, 6);
			assert.equal(deniedAgain.fence, 6);
			assert.equal(deniedAgain.failureHistory.length, 6);
			assert.deepEqual(
				deniedAgain.failureHistory[0],
				blocked.failureHistory[0],
			);
			assert.equal(counts.models, before.models);
			assert.equal(counts.initialize, before.initialize);
			assert.deepEqual((await call("retry", command)).json(), accepted.json());
			assert.equal(ledger.status(d.id).occurrences[0].status, "blocked");
			diagnosticRecovered = true;
			const recover = { ...command, commandId: randomUUID(), expectedFence: 6 };
			assert.equal((await call("retry", recover)).statusCode, 202);
			await until(
				() => ledger.status(d.id).occurrences[0].status === "completed",
				30000,
			);
			const completed = ledger.status(d.id).occurrences[0];
			assert.equal(completed.attempts, 7);
			assert.equal(completed.fence, 7);
			for (const key of ["id", "input", "scheduledAt", "order", "revision"])
				assert.equal(completed[key], blocked[key]);
			assert.equal(completed.lastFailure, undefined);
			assert.deepEqual(completed.failureHistory, deniedAgain.failureHistory);
			assert.equal(
				(
					await call("retry", {
						...recover,
						commandId: randomUUID(),
						expectedFence: 7,
					})
				).statusCode,
				409,
			);
			assert.equal((await call("retry", recover)).statusCode, 202);
		}
		for (const id of ["read-set-normal", "read-set-rotate"]) {
			const d = definition(id, `scope-${id}`);
			d.instruction = `Review both issues in ${id}`;
			const before = counts.resultCommits;
			await call("definitions", { contractVersion: 1, definition: d });
			await call("occurrences", {
				...event,
				automationId: d.id,
				eventId: `event-${id}`,
				input: "Review currently accessible issues",
			});
			if (id === "read-set-normal") {
				await until(() => delayedModelComplete, 15000);
				assert.equal(delayedActivityEntered, true);
				assert.equal(readSetContentReads, 2);
				assert.equal(delayedActivityReleased, false);
				// Allow the native final event to reach the runtime receipt barrier.
				await new Promise((resolve) => setTimeout(resolve, 250));
				assert.equal(results.has(ledger.status(id).occurrences[0].id), false);
				releaseDelayedActivity();
			}
			await until(
				() => ledger.status(id).occurrences[0]?.status === "completed",
				90000,
			);
			assert.ok(results.has(ledger.status(id).occurrences[0].id));
			assert.equal(counts.resultCommits, before + 1);
		}
		assert.equal(
			[...sessions.values()].filter(
				(s) =>
					s.grantId ===
					`grant-${ledger.status("read-set-rotate").occurrences[0].id}`,
			).length,
			1,
			"slow turns retain the same SDK session",
		);
		assert.equal(readSetContentReads, 4);
		assert.equal(readSetRotated, true);
		assert.ok(
			sessionRenewals >= 4,
			"multiple renewals during EACH slow model turn",
		);
		{
			const d = definition("source-free", "customer-source-free");
			d.instruction =
				"Reply naturally to this internal greeting without external sources";
			const before = {
				results: counts.resultCommits,
				tools: counts.tools,
				initialize: counts.initialize,
			};
			await call("definitions", { contractVersion: 1, definition: d });
			await call("occurrences", {
				...event,
				automationId: d.id,
				eventId: "internal-greeting",
				input: "hi!",
			});
			await until(() => counts.resultCommits === before.results + 1);
			await until(
				() => ledger.status(d.id).occurrences[0].status === "completed",
			);
			assert.equal(counts.tools, before.tools);
			assert.equal(counts.initialize, before.initialize);
			const response = [...activityReceipts.values()].find(
				(e) =>
					e.item.kind === "activity" &&
					e.item.sessionId.startsWith("automation:source-free:") &&
					e.item.payload.content.type === "response",
			);
			assert.ok(
				response,
				"source-free model result persists through the same session sink",
			);
		}
		if (codexImage) {
			const id = randomUUID();
			const d = definition(id, `engineering:${id}`);
			d.scopeRef = d.namespace;
			d.role = "engineering";
			d.instruction = "Reviewed engineering assignment";
			d.session = {
				id: `assignment:${id}`,
				scopeRef: d.scopeRef,
				role: d.role,
			};
			const engineering = {
				assignmentId: id,
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
				allowedPaths: ["sum.cjs", "sum.test.cjs", "retained.txt"],
				files: {
					"sum.cjs": "exports.sum=(a,b)=>a-b;",
					"sum.test.cjs":
						"const {test}=require('node:test'),assert=require('node:assert/strict'),{sum}=require('./sum.cjs');test('sum',()=>assert.equal(sum(2,3),5));",
				},
			};
			engineeringAssignments.set(id, engineering);
			assert.equal(
				(await call("definitions", { contractVersion: 1, definition: d }))
					.statusCode,
				200,
			);
			const before = counts.resultCommits;
			await call("occurrences", {
				...event,
				automationId: id,
				eventId: "reviewed-assignment",
				input: "Reviewed engineering work",
			});
			if (id === "read-set-normal") {
				await until(() => delayedModelComplete, 15000);
				assert.equal(delayedActivityEntered, true);
				assert.equal(readSetContentReads, 2);
				assert.equal(delayedActivityReleased, false);
				// Allow the native final event to reach the runtime receipt barrier.
				await new Promise((resolve) => setTimeout(resolve, 250));
				assert.equal(results.has(ledger.status(id).occurrences[0].id), false);
				releaseDelayedActivity();
			}
			await until(
				() => ledger.status(id).occurrences[0]?.status === "completed",
				90000,
			);
			assert.ok(results.has(ledger.status(id).occurrences[0].id));
			assert.equal(counts.resultCommits, before + 1);
			assert.equal(engineeringPublications.size, 1);
			assert.ok(engineeringCalls >= 2);
			assert.equal(lostEngineeringAck, true);
			const receipt = [...activityReceipts.values()].find(
				(e) => e.item.kind === "session" && e.item.sessionId === d.session.id,
			);
			assert.deepEqual(receipt.item.payload, d.session);
		}

		await runtime.stop();
		assert.equal(
			(
				await call(
					"occurrences",
					eventInput(slackEvents, "paused-event", "must never run"),
				)
			).statusCode,
			200,
		);
		await call("definitions", {
			contractVersion: 1,
			definition: { ...slackEvents, revision: 2, state: "paused" },
		});
		assert.equal(
			ledger.status(slackEvents.id).occurrences.at(-1).status,
			"cancelled",
		);
		assert.equal(
			(
				await call(
					"occurrences",
					eventInput(slackEvents, "after-pause", "denied"),
				)
			).statusCode,
			409,
		);
		for (const filename of await readdir(checkpoints)) {
			const raw = await readFile(join(checkpoints, filename), "utf8");
			const native = JSON.parse(raw).native;
			const saved =
				raw +
				(native ? Buffer.from(native.rollout, "base64").toString("utf8") : "");
			assert.ok(!saved.includes(supervisorKey));
			assert.ok(!saved.includes(modelKey));
			assert.ok(!saved.includes('"token"'));
			assert.ok(!saved.includes('"grantId"'));
		}
		assert.equal(lostActivityAck, true);
		assert.ok(activityReceipts.size >= 6);
		const summary = {
			target,
			...(codexImage && { containedImage: codexImage }),
			activityReceipts: activityReceipts.size,
			delayedDelivery: {
				modelAndTwoReadsBeforeActivityAck:
					delayedModelComplete && delayedActivityEntered,
				resultWaitedForAck: delayedActivityReleased,
				modelDelayMs: 100,
				toolDelayMs: 200,
			},
			executionTiming: [...measuredCompletions.values()],
			readSets: {
				contentReads: readSetContentReads,
				slowModelTurns: readSetRotated ? 2 : 0,
				sessionRenewals,
			},
			engineering: {
				assignments: engineeringAssignments.size,
				publications: engineeringPublications.size,
				calls: engineeringCalls,
				lostAckRecovered: lostEngineeringAck,
			},
			delegation: {
				children: delegatedChildren.size,
				calls: delegationCalls,
				lostAckRecovered: lostDelegationAck,
			},
			passed: true,
			directory,
			counts,
			assertions: [
				...(codexImage
					? [
							"reviewed assignment-only engineering: real isolated failing test, retained edit, model-directed repair/passing rerun, one immutable publication receipt across lost ACK and native reconnect",
						]
					: []),
				"instruction through registered HTTP routes",
				"delayed intermediate activity ACK overlaps delayed model and two SDK tool calls; result remains blocked until exact ordered receipts ACK",
				"authenticated idempotent operator recovery preserves original occurrence, denies widening/active/completed work, exhausts a revoked three-attempt cycle, then completes only after current authority admits a new explicit cycle",
				"pre-checkpoint authority denial persists safe admission phase/status and per-attempt failure history through explicit retry and success; visible only through authenticated runtime status",
				"customer read-set list/two reads through one current SDK session; two 25-second model turns each outlast the 20-second lease while negotiated renewal preserves exact references",
				"source-free contained model reply with zero grants, no MCP initialization and durable normalized response/result",
				"model-facing direct/ticket delegation through SDK MCP, stable payload identity across lost ACK/new attempt/repeated native calls, exactly one child per request",
				"direct and assigned-ticket child descriptors, parent linkage and separate durable activity journals",
				"negotiated durable normalized session activities, lost activity ACK, terminal flush before result and receipt-only reconnect",
				"admitted Slack/Linear event idle wake, active-turn queue, duplicate/out-of-order delivery and restart retention",
				"event pause denial and cross-customer context separation",
				"actual scheduled tick",
				"negotiated cumulative execution duration excludes receipt recovery; slow native/model calls measured, legacy lifecycle fields unchanged",
				"non-customer automation",
				"durable result ACK recovery after pause and restart with model unavailable",
				"no model/tool/progress reopening",
				"real MCP SDK initialize/list/call/reconnect",
				"open-session expiry/revocation",
				"supervisor key rejected at MCP",
				"forged authority and live copied instance denied",
				"strict fixed-resource arguments",
				"private checkpoints without credentials",
			],
			limitations: [
				"Hosted authority/provider/model transports are controlled fixtures; real hosted connected gate still required",
				"No live provider or model calls; actual signature/subscription/mapping proof is Hosted-owned",
				"Customer read sets use controlled session references; live association/mapping validation remains Hosted-owned",
				...(codexImage
					? [
							"Engineering publication receipt is a controlled MCP fixture, not a live GitHub write or hosted SQL proof",
						]
					: [
							"Engineering requires the opt-in immutable native image; not exercised by Messages-only drive",
						]),
			],
		};
		await writeFile(
			join(directory, "summary.json"),
			JSON.stringify(summary, null, 2),
		);
		return summary;
	} finally {
		releaseDelayedActivity();
		releaseEventModel();
		await runtimeApp?.close();
		ledger.close();
		for (const session of sessions.values()) await session.server.close();
		await app.close();
		globalThis.fetch = realFetch;
	}
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	runAutomationDrive()
		.then((summary) => console.log(JSON.stringify(summary, null, 2)))
		.catch((error) => {
			console.error(error);
			process.exitCode = 1;
		});
}
