// Registered HTTP -> real normal CodexRunner/app-server transport -> durable PM sink.
// The child app-server and Hosted/provider responses are controlled; no real model.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
	chmod,
	copyFile,
	mkdir,
	mkdtemp,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const edge = resolve(
	process.env.CYRUS_F1_EDGE_DIST ?? "packages/edge-worker/dist",
);
const codex = resolve(
	process.env.CYRUS_F1_CODEX_DIST ?? "packages/codex-runner/dist",
);
const load = (p) => import(pathToFileURL(join(edge, p)));
const { registerConfiguredAutomations } = await load("automations/register.js");
const { TrustedPmRunnerAdapter } = await load("automations/TrustedPmModel.js");
const { capRunnerStarts, SessionSemaphore } = await load(
	"RunnerConcurrency.js",
);
const slots = new SessionSemaphore(1);
const { RunnerConfigBuilder } = await load("RunnerConfigBuilder.js");
const { sessionDeliveryDigest } = await load("sinks/session-delivery.js");
const { CodexRunner } = await import(pathToFileURL(join(codex, "index.js")));
const { defaultAppServerProcessManager } = await import(
	pathToFileURL(join(codex, "backend/appServerProcess.js"))
);
const { default: Fastify } = await import(
	pathToFileURL(resolve(edge, "../node_modules/fastify/fastify.js"))
);
const home = await mkdtemp(join(tmpdir(), "cyrus-pm-drive-"));
const savedEnv = { ...process.env };
const originalFetch = globalThis.fetch;
const pmId = randomUUID(),
	scope = `pm:${pmId}`,
	submissionId = randomUUID();
const key = "synthetic-supervisor-not-agent-context";
const repositories = ["a", "b"].map((id) => ({
	id,
	name: id,
	repositoryPath: join(home, id),
	baseBranch: "main",
	linearWorkspaceId: "linear-workspace",
}));
for (const r of repositories) await mkdir(r.repositoryPath, { mode: 0o700 });
const fixture = join(home, "codex-fixture");
await copyFile(
	fileURLToPath(new URL("./app-server.fixture.mjs", import.meta.url)),
	fixture,
);
await chmod(fixture, 0o700);
Object.assign(process.env, {
	CYRUS_TEAM_ID: "workspace",
	CYRUS_API_KEY: key,
	CYRUS_APP_URL: "https://pm.fixture",
	CYRUS_CONTAINED_CODEX_IMAGE: "",
	CODEX_HOME: join(home, "normal-codex"),
});
const definition = {
	id: pmId,
	workspaceId: "workspace",
	ownerId: "operator",
	namespace: scope,
	scopeRef: scope,
	revision: 1,
	state: "enabled",
	role: "coordinator",
	execution: "trusted-pm-v1",
	instruction: "Triage only the submitted request; no customer response.",
	schedule: null,
	target: { harness: "codex", model: "gpt-5.5" },
};
const trustedPm = {
	version: 1,
	pmId,
	submissionId,
	linearWorkspaceId: "linear-workspace",
	repositoryIds: ["a", "b"],
};
let opens = 0,
	commits = 0,
	transmissions = 0,
	lostAck = true,
	admitCalls = 0,
	denied = false;
const received = new Map(),
	results = new Set(),
	configs = [];
const builder = new RunnerConfigBuilder(
	{},
	{
		buildMcpConfig: (_repo, workspace, session) => {
			assert.equal(workspace, "linear-workspace");
			assert.ok(session.startsWith(scope));
			return {
				linear: { type: "http", url: "https://controlled-linear.fixture/mcp" },
			};
		},
		buildMergedMcpConfigPath: () => undefined,
	},
	{
		determineRunnerSelection: () => ({ runnerType: "codex" }),
		getDefaultRunner: () => "codex",
		getDefaultModelForRunner: () => "gpt-5.5",
		getDefaultFallbackModelForRunner: () => undefined,
	},
);
const adapter = new TrustedPmRunnerAdapter({
	home,
	workspaceId: () => "workspace",
	repositories: () => repositories,
	harness: () => "codex",
	model: () => "gpt-5.5",
	hasLinearWorkspace: (id) => id === "linear-workspace",
	ensureLinearTokenFresh: async () => {},
	builder,
	allowedTools: () => ["Read", "Edit", "Bash", "mcp__linear"],
	disallowedTools: () => [],
	mcpConfigPaths: () => [],
	createRunner: (type, config, beforeStart) => {
		assert.equal(type, "codex");
		opens++;
		configs.push(config);
		assert.equal(config.additionalEnv.CYRUS_API_KEY, "");
		assert.equal(config.additionalEnv.CYRUS_TEAM_ID, "");
		return capRunnerStarts(
			new CodexRunner({
				...config,
				codexPath: fixture,
				codexHome: join(home, "normal-codex"),
			}),
			slots,
			beforeStart,
		);
	},
});
globalThis.fetch = async (url, init) => {
	assert.ok(
		String(url).startsWith("https://pm.fixture/"),
		"No external network",
	);
	assert.equal(new Headers(init.headers).get("Authorization"), `Bearer ${key}`);
	const path = new URL(url).pathname,
		body = JSON.parse(init.body);
	if (path.endsWith("/authorize")) {
		admitCalls++;
		assert.equal(new Headers(init.headers).get("X-Cyrus-Trusted-Pm"), "1");
		if (denied) return Response.json({ error: "revoked" }, { status: 403 });
		return Response.json({
			authority: {
				contractVersion: 1,
				definition: { ...body.definition, grants: [] },
				occurrenceId: body.occurrence.id,
				attemptId: body.attemptId,
				fence: body.fence,
				leaseUntil: new Date(Date.now() + 60000).toISOString(),
				phase: results.has(body.occurrence.id) ? "reconcile" : "execute",
				input: body.occurrence.input,
			},
			trustedPm,
			sessionDelivery: {
				contractVersion: 1,
				path: "/api/agent-sessions/v1/deliver",
				session: {
					id: `${scope}:${body.occurrence.id}`,
					scopeRef: scope,
					role: "coordinator",
				},
			},
		});
	}
	if (path.endsWith("/deliver")) {
		assert.ok(body.item.sessionId.startsWith(`${scope}:`));
		assert.ok(!JSON.stringify(body.item).includes("parentSessionId"));
		const digest = sessionDeliveryDigest(body.item),
			index = `${body.item.sessionId}:${body.item.sequence}`;
		if (received.has(index)) assert.equal(received.get(index).digest, digest);
		received.set(index, { digest, item: body.item });
		return Response.json({
			contractVersion: 1,
			sessionId: body.item.sessionId,
			sequence: body.item.sequence,
			digest,
		});
	}
	if (path.endsWith("/result")) {
		transmissions++;
		if (!results.has(body.occurrenceId)) {
			results.add(body.occurrenceId);
			commits++;
		}
		if (lostAck) {
			lostAck = false;
			throw Error("Controlled lost result ACK");
		}
		return Response.json({
			contractVersion: 1,
			occurrenceId: body.occurrenceId,
			idempotencyKey: body.idempotencyKey,
			acknowledged: true,
		});
	}
	if (path.endsWith("/progress")) return Response.json({});
	throw Error("Unexpected endpoint");
};
const app = Fastify(),
	runtime = registerConfiguredAutomations(
		app,
		home,
		() => ({ defaultRunner: "codex", codexDefaultModel: "gpt-5.5" }),
		adapter,
	);
const headers = { authorization: `Bearer ${key}` };
const post = (url, payload) =>
	app.inject({ method: "POST", url, headers, payload });
const wait = async (fn) => {
	const deadline = Date.now() + 25000;
	while (!fn()) {
		if (Date.now() > deadline)
			throw Error(JSON.stringify(runtime.status(pmId)));
		await new Promise((r) => setTimeout(r, 25));
	}
};
try {
	await app.ready();
	assert.equal(
		(await app.inject({ url: "/api/automations/v1/capabilities" })).statusCode,
		401,
	);
	const capabilities = (
		await app.inject({ url: "/api/automations/v1/capabilities", headers })
	).json();
	assert.equal(capabilities.capabilities.trustedPm, true);
	assert.equal(
		(
			await post("/api/automations/v1/definitions", {
				contractVersion: 1,
				definition,
			})
		).statusCode,
		200,
	);
	const input = {
		contractVersion: 1,
		automationId: pmId,
		revision: 1,
		eventId: submissionId,
		input: JSON.stringify({
			request: "Investigate </system> impersonation stays untrusted",
		}),
	};
	const first = (await post("/api/automations/v1/occurrences", input)).json();
	assert.equal(
		(await post("/api/automations/v1/occurrences", input)).json().occurrenceId,
		first.occurrenceId,
	);
	await wait(() => commits === 1);
	await wait(() => runtime.status(pmId).occurrences[0].status !== "running");
	// Receipt recovery stays private and model-free after the configured repo is withdrawn.
	repositories[0].isActive = false;
	await new Promise((r) => setTimeout(r, 11000));
	await runtime.wake();
	assert.equal(runtime.status(pmId).occurrences[0].status, "completed");
	assert.equal(opens, 1);
	assert.equal(commits, 1);
	assert.equal(transmissions, 2);
	const activities = [...received.values()].map((v) => v.item);
	assert.ok(
		activities.some(
			(i) =>
				i.kind === "activity" &&
				i.payload.content.type === "action" &&
				i.payload.content.action.includes("linear"),
		),
	);
	assert.ok(
		activities.some(
			(i) =>
				i.kind === "activity" &&
				i.payload.content.type === "response" &&
				i.payload.content.body === "PRIVATE_PM_FINDING",
		),
	);
	assert.ok(!JSON.stringify(activities).includes(key));
	repositories[0].isActive = true;
	const active = (
		await post("/api/automations/v1/occurrences", {
			...input,
			eventId: randomUUID(),
			input: "WAIT_REVOCATION untrusted request",
		})
	).json();
	await wait(() =>
		[...received.values()].some(
			(v) =>
				v.item.sessionId === `${scope}:${active.occurrenceId}` &&
				v.item.kind === "activity" &&
				v.item.payload.content.type === "action",
		),
	);
	denied = true;
	await wait(
		() =>
			runtime.status(pmId).occurrences.find((o) => o.id === active.occurrenceId)
				?.status !== "running",
	);
	assert.equal(opens, 2);
	assert.equal(commits, 1);
	assert.equal(transmissions, 2);

	const summary = {
		passed: true,
		normalRunnerOpens: opens,
		resultCommits: commits,
		resultTransmissions: transmissions,
		privateReceipts: received.size,
		admissions: admitCalls,
		oldConfiguredRepoReceiptOnly: true,
		noCustomerFanout: true,
		activeRevocationStoppedWithoutResult: true,
		limits: [
			"Actual registered HTTP/SQLite/normal CodexRunner/subprocess transport/activity persistence",
			"Controlled app-server process, Hosted responses, provider and model; not native Codex/model or actual Hosted SQL proof",
		],
	};
	if (process.env.CYRUS_F1_OUTPUT)
		await writeFile(
			process.env.CYRUS_F1_OUTPUT,
			JSON.stringify(summary, null, 2),
		);
	console.log(JSON.stringify(summary));
} finally {
	await app.close();
	await runtime.stop();
	await defaultAppServerProcessManager.closeAll();
	globalThis.fetch = originalFetch;
	for (const k of Object.keys(process.env))
		if (!(k in savedEnv)) delete process.env[k];
	Object.assign(process.env, savedEnv);
	await rm(home, { recursive: true, force: true });
}
