// Controlled pairing transport; actual AuthCommand, StartCommand and registered
// automation routes. No real auth code, account, tunnel or provider/model request.
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerConfiguredAutomations } from "../../packages/edge-worker/dist/automations/register.js";
import { AuthCommand } from "../cli/dist/src/commands/AuthCommand.js";
import { loadRuntimeEnv } from "../cli/dist/src/utils/loadRuntimeEnv.js";

const require = createRequire(
	new URL("../../packages/edge-worker/package.json", import.meta.url),
);
const Fastify = require("fastify");
const directory = await mkdtemp(join(tmpdir(), "cyrus-preview-pairing-f1-"));
const preview = "https://cyrus-preview-cyhost-1321.vercel.app";
const envBefore = { ...process.env };
const originalFetch = globalThis.fetch;
const consoleLog = console.log;
const output = [];
const fixture = Fastify({ forceCloseConnections: true });
let runtimeServer;
let runtimeOrigin;
const team = "11111111-1111-4111-8111-111111111111";
let bootstrapRequests = 0;
let authRequests = 0;
let launchCount = 0;
try {
	console.log = (...args) => output.push(args.join(" "));
	fixture.get("/api/config", async (request) => {
		assert.equal(request.url, "/api/config");
		assert.equal(request.headers.authorization, "Bearer f1-pairing-code");
		assert.equal(
			request.headers["x-cyrus-config-capabilities"],
			"self-host-port-v1",
		);
		authRequests++;
		return {
			success: true,
			config: {
				apiKey: "f1-runtime-key",
				cloudflareToken: "f1-tunnel-token",
				teamId: team,
				serverPort: 19119,
			},
		};
	});
	fixture.get("/api/config/runtime", async (request) => {
		assert.equal(request.headers.authorization, "Bearer f1-runtime-key");
		assert.equal(request.headers["x-cyrus-team-id"], team);
		bootstrapRequests++;
		return {
			success: true,
			bootstrap: {
				contractVersion: 1,
				teamId: team,
				cyrusConfig: {
					repositories: [],
					defaultRunner: "claude",
					claudeDefaultModel: "claude-fixture",
				},
				environment: { CYRUS_TEAM_ID: team, ANTHROPIC_API_KEY: "f1-model-key" },
			},
		};
	});
	const fixtureOrigin = await fixture.listen({ port: 0, host: "127.0.0.1" });
	globalThis.fetch = async (url, init) => {
		if (
			[`${preview}/api/config`, `${preview}/api/config/runtime`].includes(
				String(url),
			)
		) {
			assert.equal(init.redirect, "error");
			return originalFetch(`${fixtureOrigin}${new URL(url).pathname}`, init);
		}
		if (
			runtimeOrigin &&
			String(url).startsWith(`${runtimeOrigin}/api/automations/v1/`)
		)
			return originalFetch(url, init);
		throw new Error("F1 denied unexpected external transport");
	};
	process.env.CYRUS_APP_URL = `${preview}/`;
	// Fresh pairing must obtain workspace/model config from authenticated bootstrap.
	for (const name of [
		"CYRUS_TEAM_ID",
		"CYRUS_DEFAULT_RUNNER",
		"CYRUS_DEFAULT_MODEL",
		"CYRUS_CLAUDE_DEFAULT_MODEL",
		"ANTHROPIC_API_KEY",
		"CLAUDE_CODE_OAUTH_TOKEN",
	])
		delete process.env[name];
	await writeFile(
		join(directory, ".env"),
		"CYRUS_APP_URL=https://app.atcyrus.com\n",
	);
	loadRuntimeEnv(join(directory, ".env"));
	const logger = Object.fromEntries(
		["success", "error", "divider", "raw", "info"].map((name) => [
			name,
			(...args) => output.push(args.join(" ")),
		]),
	);
	const app = {
		cyrusHome: directory,
		version: "f1-source-build",
		logger,
		config: {
			load: () =>
				JSON.parse(
					require("node:fs").readFileSync(
						join(directory, "config.json"),
						"utf8",
					),
				),
		},
		worker: {
			startEdgeWorker: async () => {
				assert.equal(process.env.CYRUS_APP_URL, `${preview}/`);
				assert.equal(process.env.CYRUS_SERVER_PORT, "19119");
				runtimeServer = Fastify({ forceCloseConnections: true });
				registerConfiguredAutomations(runtimeServer, directory, () =>
					app.config.load(),
				);
				runtimeOrigin = await runtimeServer.listen({
					port: 0,
					host: "127.0.0.1",
				});
				launchCount++;
			},
			getServerPort: () => new URL(runtimeOrigin).port,
		},
		setupSignalHandlers() {},
	};
	await new AuthCommand(app).execute(["f1-pairing-code"]);
	const response = await fetch(
		`${runtimeOrigin}/api/automations/v1/capabilities`,
		{ headers: { Authorization: "Bearer f1-runtime-key" } },
	);
	assert.equal(response.status, 200);
	const capabilities = await response.json();
	assert.equal(capabilities.available, true);
	assert.equal(capabilities.workspaceId, team);
	assert.equal(capabilities.capabilities.scopedMcp, true);
	assert.equal(capabilities.capabilities.engineering, false);
	assert.equal(
		(await fetch(`${runtimeOrigin}/api/automations/v1/capabilities`)).status,
		401,
	);
	assert.equal((await stat(join(directory, ".env"))).mode & 0o777, 0o600);
	assert.match(
		await readFile(join(directory, ".env"), "utf8"),
		/CYRUS_APP_URL='https:\/\/cyrus-preview-cyhost-1321.vercel.app'\n/,
	);
	for (const secret of [
		"f1-pairing-code",
		"f1-runtime-key",
		"f1-tunnel-token",
		"f1-model-key",
	])
		assert.equal(output.join("\n").includes(secret), false);
	assert.equal(authRequests, 1);
	assert.equal(bootstrapRequests, 1);
	assert.equal(launchCount, 1);
	const summary = {
		passed: true,
		bootstrapRequests,
		authRequests,
		launchCount,
		previewOrigin: preview,
		registeredWorkspacePreserved: true,
		hostedListenerPortPreserved: true,
		authHeaderOnly: true,
		credentialFreeLogs: true,
		privateCredentials: true,
		capabilities,
		limitations: [
			"Local HTTP fixture stands in for hosted auth; no real account pairing",
			"No live model or provider request",
			"Cyrus-owned session persistence/UI gate is separate",
		],
	};
	await writeFile(
		join(directory, "summary.json"),
		`${JSON.stringify(summary, null, 2)}\n`,
		{ mode: 0o600 },
	);
	consoleLog(
		JSON.stringify(
			{ ...summary, evidence: join(directory, "summary.json") },
			null,
			2,
		),
	);
} finally {
	await runtimeServer?.close();
	await fixture.close();
	globalThis.fetch = originalFetch;
	console.log = consoleLog;
	for (const key of Object.keys(process.env))
		if (!(key in envBefore)) delete process.env[key];
	Object.assign(process.env, envBefore);
}
