// Existing native-context F1 scenario joined to frozen Hosted handlers and SQL.
// Load reviewed installed packages only; use synthetic broker credentials.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [directory, prefix] = process.argv.slice(2);
const fixture = JSON.parse(
	await readFile(join(directory, "fixture.json"), "utf8"),
);
const modules = join(prefix, "lib/node_modules/cyrus-edge-worker");
const manifest = JSON.parse(
	await readFile(join(modules, "package.json"), "utf8"),
);
assert.match(process.env.CYRUS_NATIVE_JOIN_RUNTIME_SHA ?? "", /^[a-f0-9]{40}$/);
assert.equal(
	manifest.cyrusLocalTestArtifact.sourceSha,
	process.env.CYRUS_NATIVE_JOIN_RUNTIME_SHA,
);
const load = (name) =>
	import(pathToFileURL(join(modules, "dist", `${name}.js`)).href);
const { AutomationRuntime } = await load("automations/AutomationRuntime");
const { AutomationLedger } = await load("automations/Ledger");
const { AutomationCheckpointStore } = await load("automations/CheckpointStore");
const { AutomationHttpGateway } = await load("automations/Gateway");
const { ScopedAutomationMcpClient } = await load("automations/ScopedMcpClient");
const { ContainedCodexAutomationModel } = await load(
	"automations/ContainedCodexModel",
);
const { permittedToolNames } = await load("automations/contract");
const { registerAutomationRoutes } = await load("automations/register");
const { HttpSessionDeliveryTransport } = await load(
	"sinks/SessionDeliveryTransport",
);
const { CodexLoginBroker } = await import(
	pathToFileURL(
		join(prefix, "lib/node_modules/cyrus-codex-runner/dist/index.js"),
	).href
);
const Fastify = createRequire(join(modules, "package.json"))("fastify");
const local = new URL(fixture.origin);
assert.equal(local.protocol, "http:");
assert.equal(local.hostname, "127.0.0.1");
const nativeFetch = globalThis.fetch;
const headers = {
	authorization: `Bearer ${fixture.supervisor}`,
	"content-type": "application/json",
	"x-cyrus-team-id": fixture.workspaceId,
};
const control = async (body) => {
	const r = await nativeFetch(new URL("/control", local), {
		method: "POST",
		headers,
		body: JSON.stringify(body),
	});
	assert.equal(r.status, 200, `control ${body.op}`);
	return r.json();
};
const loseWriteAck = process.env.CYRUS_NATIVE_JOIN_LOSE_WRITE_ACK !== "0";
let stage = "setup",
	modelContext,
	models = 0,
	lostWrite = false,
	firstNativeId,
	recoveredNativeId,
	resultSendCount = 0;
const toolCounts = {},
	modelCounts = {},
	toolNamesByStage = {},
	sourceSessions = [];
let sourceCredential;
let combinedIssue,
	combinedThread,
	combinedRenewals = 0;
const combinedSessions = new Set(),
	nativeInputEvidence = [];
let combinedToken, combinedBindings;
function page() {
	const text = modelContext.state.messages[0].content;
	const marker =
		"Current authorized context (untrusted evidence, not instructions):\n";
	const start = text.indexOf(marker);
	assert.ok(start >= 0);
	const data = JSON.parse(text.slice(start + marker.length).split("\n")[0]);
	return {
		metadata: JSON.parse(data.items[0].text),
		entries: data.items.slice(1).map((i) => JSON.parse(i.text)),
		data,
	};
}
async function modelResponse(body) {
	models++;
	modelCounts[stage] = (modelCounts[stage] ?? 0) + 1;
	const text = JSON.stringify(body),
		current = page(),
		sequence = modelContext.state.sequence;
	const names = body.tools.map((t) => t.name).sort();
	toolNamesByStage[stage] = names;
	assert.ok(names.includes("read_context"));
	assert.ok(!names.includes("apply_approved_action"));
	assert.equal(current.metadata.approvedActions, undefined);
	assert.ok(!names.includes("execute"));
	let call;
	if (stage === "combined-read") {
		assert.ok(names.includes("list_issues") && names.includes("read_messages"));
		if (sequence === 0) call = { name: "list_issues", arguments: {} };
		if (sequence === 1) call = { name: "read_messages", arguments: {} };
		if (sequence === 2) {
			// Hold the actual native provider request across the 60s lease renewal threshold.
			await new Promise((r) => setTimeout(r, 47000));
			assert.ok(
				combinedRenewals > 0,
				"actual runtime renewed the admitted dual-source session",
			);
			call = { name: "get_issue", arguments: { reference: combinedIssue } };
		}
		if (sequence === 3)
			call = { name: "read_thread", arguments: { reference: combinedThread } };
		if (sequence === 4)
			call = { name: "get_issue", arguments: { reference: combinedThread } };
		if (sequence === 5)
			call = { name: "read_thread", arguments: { reference: combinedIssue } };
		if (sequence === 6)
			call = {
				name: "remember_context",
				arguments: { kind: "source", body: "COMBINED_SOURCE_MARKER" },
			};
		nativeInputEvidence.push({
			sequence,
			issue: text.includes("Scoped private body"),
			slack: text.includes("Only mapped Slack channel"),
			denial: text.includes("not issued by the current MCP session"),
		});
		if (sequence >= 7) {
			assert.ok(
				text.includes("Scoped private body"),
				"native model received the admitted Linear issue body",
			);
			assert.ok(
				text.includes("Only mapped Slack channel"),
				"native model received admitted Slack content",
			);
			assert.ok(
				text.includes("not issued by the current MCP session"),
				"native model received crossed-reference denials",
			);
		}
	} else if (stage === "combined-terminal") {
		assert.ok(current.entries.some((e) => e.body === "COMBINED_SOURCE_MARKER"));
	} else if (stage === "combined-survivor") {
		assert.ok(!names.includes("read_messages"));
		assert.ok(names.includes("list_issues"));
		assert.ok(!text.includes("COMBINED_SOURCE_MARKER"));
		if (sequence === 0) call = { name: "list_issues", arguments: {} };
		if (sequence === 1)
			call = { name: "get_issue", arguments: { reference: combinedIssue } };
	} else if (stage === "memory-write") {
		if (
			sequence === 0 &&
			!current.entries.some((e) => e.body === "JOIN_REMEMBERED_DETAIL")
		)
			call = {
				name: "remember_context",
				arguments: {
					kind: "confirmed",
					body: "JOIN_REMEMBERED_DETAIL",
					evidence_reference: current.metadata.inputEvidence[0].reference,
				},
			};
		else recoveredNativeId = modelContext.state.native.threadId;
		firstNativeId ??= modelContext.state.native.threadId;
	} else if (stage === "memory-recall")
		assert.ok(current.entries.some((e) => e.body === "JOIN_REMEMBERED_DETAIL"));
	else if (stage === "work-create" && sequence === 0)
		call = {
			name: "track_work",
			arguments: { objective: "Investigate synthetic joined export" },
		};
	else if (stage === "work-verify" && sequence === 0)
		call = {
			name: "track_work",
			arguments: {
				reference: current.metadata.work[0].reference,
				status: "verified",
				outcome_reference: current.metadata.outcomes[0].reference,
			},
		};
	else if (stage === "source-write" && sequence === 0)
		call = {
			name: "remember_context",
			arguments: { kind: "source", body: "WITHDRAWN_SOURCE_MARKER" },
		};
	else if (stage === "source-read")
		assert.ok(
			current.entries.some((e) => e.body === "WITHDRAWN_SOURCE_MARKER"),
		);
	else if (stage === "source-removed") {
		assert.ok(!text.includes("WITHDRAWN_SOURCE_MARKER"));
		assert.equal(current.entries.length, 0);
		assert.ok(!names.includes("read_messages"));
	}
	if (call) {
		assert.ok(names.includes(call.name));
		for (const key of ["reference", "evidence_reference", "outcome_reference"])
			if (call.arguments[key])
				assert.ok(
					text.includes(call.arguments[key]),
					"reference present in native model input",
				);
	}
	const item = call
		? {
				type: "function_call",
				id: "fc_join",
				call_id: `call_join_${sequence}`,
				name: call.name,
				arguments: JSON.stringify(call.arguments),
			}
		: {
				type: "message",
				id: "msg_join",
				role: "assistant",
				content: [
					{
						type: "output_text",
						text: `Completed controlled ${stage}.`,
						annotations: [],
					},
				],
				status: "completed",
			};
	const response = {
		id: "resp_join",
		object: "response",
		status: "completed",
		output: [item],
		usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
	};
	const stream = [
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
	return new Response(stream, {
		headers: { "content-type": "text/event-stream" },
	});
}
globalThis.fetch = async (url, init) => {
	const request = new URL(url);
	if (
		request.origin === "https://chatgpt.com" &&
		request.pathname === "/backend-api/codex/responses"
	)
		return modelResponse(JSON.parse(init.body)).catch((error) => {
			console.error(
				JSON.stringify({
					stage,
					sequence: modelContext.state.sequence,
					fixtureModelError:
						error.code === "ERR_ASSERTION"
							? "fixture_assertion"
							: "fixture_response",
				}),
			);
			throw error;
		});
	assert.equal(
		request.origin,
		"https://native-join.invalid",
		"external egress denied",
	);
	const body = init?.body && JSON.parse(init.body);
	if (request.pathname === "/mcp" && body?.method === "tools/call")
		toolCounts[body.params.name] = (toolCounts[body.params.name] ?? 0) + 1;
	if (request.pathname.endsWith("/result")) resultSendCount++;
	const response = await nativeFetch(new URL(request.pathname, local), init);
	if (stage.startsWith("combined-") && response.ok) {
		if (request.pathname.endsWith("/authorize")) {
			const admission = await response.clone().json();
			if (stage === "combined-read") {
				assert.equal(
					admission.mcp.sessionRenewal,
					true,
					"initial admission must negotiate same-session renewal",
				);
				assert.equal(admission.customerSources, true);
				const bindings = JSON.stringify(admission.authority.definition.grants);
				if (combinedBindings) assert.equal(bindings, combinedBindings);
				else combinedBindings = bindings;
				if (body.phase === "renew") {
					assert.ok(
						body.mcpSessionId,
						"runtime automatically requests admitted session continuation",
					);
					assert.equal(admission.mcp.sessionId, body.mcpSessionId);
					assert.ok(combinedSessions.has(body.mcpSessionId));
					assert.notEqual(admission.mcp.token, combinedToken);
					combinedRenewals++;
				}
				combinedToken = admission.mcp.token;
			}
		}
		if (
			stage === "combined-read" &&
			request.pathname === "/mcp" &&
			body?.method === "initialize"
		) {
			const id = response.headers.get("mcp-session-id");
			assert.ok(id);
			combinedSessions.add(id);
		}
		if (request.pathname === "/mcp" && body?.method === "tools/call") {
			const data = await response.clone().json();
			const item = data.result?.structuredContent?.items?.[0];
			if (body.params.name === "list_issues" && item)
				combinedIssue = JSON.parse(item.text).issues[0].reference;
			if (body.params.name === "read_messages" && item)
				combinedThread = JSON.parse(item.text).messages[0].reference;
		}
	}
	if (
		stage.startsWith("source-") &&
		request.pathname.endsWith("/authorize") &&
		response.ok
	) {
		const a = await response.clone().json();
		sourceCredential = a.mcp.token;
	}
	if (
		stage === "source-read" &&
		request.pathname === "/mcp" &&
		body?.method === "initialize" &&
		response.ok
	)
		sourceSessions.push({
			token: sourceCredential,
			id: response.headers.get("mcp-session-id"),
		});
	if (
		loseWriteAck &&
		stage === "memory-write" &&
		request.pathname === "/mcp" &&
		body?.method === "tools/call" &&
		body.params.name === "remember_context" &&
		response.ok &&
		!lostWrite
	) {
		const data = await response.clone().json();
		if (data.result?.structuredContent?.status === "applied") {
			lostWrite = true;
			await response.body?.cancel();
			throw Error("Controlled lost memory ACK");
		}
	}
	return response;
};
const authHome = join(directory, "synthetic-login");
await mkdir(authHome, { mode: 0o700 });
await writeFile(
	join(authHome, "auth.json"),
	JSON.stringify({
		auth_mode: "chatgpt",
		tokens: {
			access_token: "synthetic-model-token-not-live",
			account_id: "fixture",
		},
	}),
	{ mode: 0o600 },
);
const broker = new CodexLoginBroker(authHome);
const model = new ContainedCodexAutomationModel(
	{
		image: process.env.CYRUS_F1_CODEX_IMAGE,
		dockerPath: process.env.CYRUS_TEST_DOCKER_PATH || "/usr/local/bin/docker",
		dockerHost:
			process.env.CYRUS_TEST_DOCKER_HOST || "unix:///var/run/docker.sock",
	},
	async (request, context) => {
		modelContext = context;
		return broker.respond(
			request,
			{
				model: "gpt-5.5",
				scopeKey: context.state.scopeKey,
				toolNames: permittedToolNames(context.authority()),
				authorize: context.authorize,
			},
			context.signal,
		);
	},
);
const ledger = new AutomationLedger(
	join(directory, "ledger"),
	fixture.workspaceId,
);
const store = new AutomationCheckpointStore(join(directory, "checkpoints"));
const credentials = () => ({
	apiKey: fixture.supervisor,
	workspaceId: fixture.workspaceId,
});
const execute = AutomationRuntime.prototype.execute;
AutomationRuntime.prototype.execute = async function (...args) {
	try {
		return await execute.apply(this, args);
	} catch (e) {
		console.error(
			JSON.stringify({ stage, runtimeFailure: e.message.slice(0, 200) }),
		);
		throw e;
	}
};
const runtime = new AutomationRuntime({
	workspaceId: () => fixture.workspaceId,
	ledger,
	store,
	model,
	gateway: new AutomationHttpGateway(
		"https://native-join.invalid",
		credentials,
		true,
	),
	sessions: {
		directory: join(directory, "sessions"),
		secrets: () => [fixture.supervisor, "synthetic-model-token-not-live"],
		transport: new HttpSessionDeliveryTransport(
			"https://native-join.invalid",
			credentials,
		),
	},
	readiness: () => ({
		harness: "codex",
		model: "gpt-5.5",
		adapter: "codex-app-server-contained-v1",
		reason: null,
	}),
	pollMilliseconds: 50,
	tools: (authority, credential, signal) =>
		new ScopedAutomationMcpClient(
			"https://native-join.invalid",
			authority,
			credential,
			signal,
		),
});
const app = Fastify({ logger: false });
registerAutomationRoutes(app, runtime, () => fixture.supervisor);
const runtimeOrigin = await app.listen({ host: "127.0.0.1", port: 0 });
const request = async (path, body) => {
	const r = await nativeFetch(`${runtimeOrigin}/api/automations/v1/${path}`, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
	});
	assert.equal(r.status, 200, `runtime ${path}`);
	return r.json();
};
const statuses = [];
async function complete(label, which = "main", prepared) {
	stage = label;
	console.error(JSON.stringify({ stage, started: true }));
	const event =
		prepared ??
		(await control({
			op: "event",
			fixture: which,
			input: `Controlled instruction: ${label}`,
		}));
	await request("definitions", {
		contractVersion: 1,
		definition: event.definition,
	});
	const created = await request("occurrences", {
		contractVersion: 1,
		automationId: event.definition.id,
		revision: event.definition.revision,
		eventId: event.eventId,
		input: event.input,
	});
	assert.equal(created.occurrenceId, event.occurrenceId);
	const deadline = Date.now() + 100000;
	while (Date.now() < deadline) {
		const o = ledger
			.status(event.definition.id)
			.occurrences.find((o) => o.id === event.occurrenceId);
		if (o?.status === "completed") {
			statuses.push({
				stage,
				status: o.status,
				attempts: o.attempts,
				fence: o.fence,
			});
			return event;
		}
		if (o?.status === "blocked") {
			console.error(
				JSON.stringify({
					stage,
					status: o.status,
					diagnostics: o.lastFailure,
					history: o.failureHistory,
				}),
			);
			throw Error(`Joined ${stage} blocked`);
		}
		await new Promise((r) => setTimeout(r, 100));
	}
	throw Error(`Joined ${stage} timed out`);
}
try {
	if (fixture.combined) {
		const capabilities = await nativeFetch(
			`${runtimeOrigin}/api/automations/v1/capabilities`,
			{ headers },
		);
		assert.equal(capabilities.status, 200);
		assert.equal(
			(await capabilities.json()).capabilities.customerSources,
			true,
		);
	}
	await complete("memory-write");
	if (loseWriteAck) {
		assert.ok(lostWrite);
		assert.notEqual(firstNativeId, recoveredNativeId);
	}
	await complete("memory-recall");
	assert.equal(
		(await control({ op: "facts" })).facts.filter(
			(x) => x === "JOIN_REMEMBERED_DETAIL",
		).length,
		1,
	);
	await complete("work-create");
	await control({ op: "proof" });
	await complete("work-verify");

	await complete("source-write", "source");
	await complete("source-read", "source");
	const old = sourceSessions.at(-1);
	assert.ok(old);
	await control({ op: "withdraw", fixture: "source" });
	const denied = await nativeFetch(new URL("/mcp", local), {
		method: "POST",
		headers: {
			authorization: `Bearer ${old.token}`,
			"mcp-session-id": old.id,
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
	});
	assert.ok(!denied.ok);
	await complete("source-removed", "source");
	if (fixture.combined) {
		await complete("combined-read", "both");
		assert.equal(
			statuses.at(-1).attempts,
			1,
			"combined read completes without a reconnect/retry",
		);
		assert.equal(
			combinedSessions.size,
			1,
			"both references stay on their initialized session",
		);
		await control({ op: "arm-result-loss", fixture: "both" });
		const opens = models;
		await complete("combined-terminal", "both");
		assert.equal(
			models - opens,
			1,
			"combined terminal recovery opens no model after source removal",
		);
		await complete("combined-survivor", "both");
	}
	await control({ op: "arm-result-loss" });
	const modelsBefore = models;
	await complete("terminal-reconcile");
	assert.equal(
		models - modelsBefore,
		1,
		"terminal ACK recovery opens no additional model",
	);
	const hosted = await control({ op: "evidence" });
	assert.ok(hosted.reconciliations > 0);
	if (loseWriteAck) assert.ok(hosted.interruptions > 0);
	assert.equal(hosted.lostResult, true);
	const summary = {
		passed: true,
		lostWriteAckScenario: loseWriteAck,
		combinedSources: fixture.combined,
		combinedRenewals,
		combinedSessions: combinedSessions.size,
		nativeInputEvidence,
		runtimeSha: manifest.cyrusLocalTestArtifact.sourceSha,
		hosted,
		models,
		modelCounts,
		toolCounts,
		toolNamesByStage,
		statuses,
		lostWrite,
		refreshedNative: firstNativeId !== recoveredNativeId,
		oldSourceSessionDenied: !denied.ok,
		terminalModelOpens: models - modelsBefore,
		resultSendCount,
		limits: [
			"Actual installed runtime/native Docker + published Hosted handlers/MCP/SQL; model and provider verification are synthetic",
			"Synthetic outbox admissions and source withdrawal; no production dispatcher or live provider membership proof",
			"No live customer/runtime/UI/provider acceptance",
		],
	};
	await writeFile(
		join(directory, "summary.json"),
		JSON.stringify(summary, null, 2),
	);
	console.log(
		JSON.stringify({
			passed: true,
			models,
			results: hosted.results,
			receipts: hosted.deliveries,
		}),
	);
} finally {
	await runtime.stop();
	await app.close();
	ledger.close();
	globalThis.fetch = nativeFetch;
}
