// Production client/SDK parser + registered HTTP routes; controlled cloudflared
// process and managed route. No real tunnel, pairing or provider/model calls.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(
	new URL(
		"../../packages/cloudflare-tunnel-client/package.json",
		import.meta.url,
	),
);
const cloudflared = require("cloudflared");
const previousBin = cloudflared.bin;
const previousFactory = cloudflared.Tunnel.withToken;
// Existing executable only satisfies the install preflight; the fixture factory
// below never spawns it. No download or external process is used.
cloudflared.use(process.execPath);
const handlers = [];
let stopped = false;
const tunnel = Object.assign(new EventEmitter(), {
	process: {
		kill() {
			stopped = true;
		},
	},
	addHandler(handler) {
		handlers.push(handler);
	},
});
cloudflared.Tunnel.withToken = () => tunnel;
const { CloudflareTunnelClient } = await import(
	"../../packages/cloudflare-tunnel-client/dist/CloudflareTunnelClient.js"
);
const { AutomationRuntime } = await import(
	"../../packages/edge-worker/dist/automations/AutomationRuntime.js"
);
const { AutomationCheckpointStore } = await import(
	"../../packages/edge-worker/dist/automations/CheckpointStore.js"
);
const { registerAutomationRoutes } = await import(
	"../../packages/edge-worker/dist/automations/register.js"
);
const edgeRequire = createRequire(
	new URL("../../packages/edge-worker/package.json", import.meta.url),
);
const Fastify = edgeRequire("fastify");
const root = await mkdtemp(join(tmpdir(), "cyrus-tunnel-routing-f1-"));
const servers = [];
const output = [];
const log = console.log;
let client;
try {
	console.log = (...args) => output.push(args.join(" "));
	async function runtime(workspaceId, key) {
		const app = Fastify({ forceCloseConnections: true });
		servers.push(app);
		const instance = new AutomationRuntime({
			workspaceId: () => workspaceId,
			gateway: {
				call() {
					throw new Error("No authority transport in this fixture");
				},
			},
			model: {
				next() {
					throw new Error("No model in this fixture");
				},
			},
			store: new AutomationCheckpointStore(join(root, workspaceId)),
			tools() {
				throw new Error("No tools in this fixture");
			},
			readiness: () => ({
				reason: "Fixture has no contained model",
				harness: "codex",
				model: "fixture",
			}),
		});
		registerAutomationRoutes(app, instance, () => key);
		return app.listen({ host: "127.0.0.1", port: 0 });
	}
	const unrelated = await runtime(
		"unrelated-workspace",
		"fixture-unrelated-key",
	);
	const feature = await runtime("feature-workspace", "fixture-feature-key");
	const expectedPort = Number(new URL(feature).port);
	client = new CloudflareTunnelClient("fixture-tunnel-token", expectedPort);
	const starting = client.startTunnel();
	for (let i = 0; i < 4; i++) tunnel.emit("connected", { id: `fixture-${i}` });
	await starting;
	assert.equal(client.isConnected(), true);
	assert.equal(client.getRoutingStatus().state, "unverified");
	function managed(origin) {
		const config = {
			ingress: [
				{ hostname: "fixture.invalid", service: origin },
				{ service: "http_status:404" },
			],
		};
		const line = `Updated to new configuration config=${JSON.stringify(JSON.stringify(config))} version=1`;
		for (const handler of handlers) handler(line, tunnel);
	}
	const headers = { Authorization: "Bearer fixture-feature-key" };
	managed(unrelated);
	assert.equal(client.getRoutingStatus().state, "mismatch");
	assert.equal(
		(await fetch(`${unrelated}/api/automations/v1/capabilities`, { headers }))
			.status,
		401,
	);
	const local = await fetch(`${feature}/api/automations/v1/capabilities`, {
		headers,
	});
	assert.equal(local.status, 200); // Local health does not fix the managed route.
	managed(feature);
	assert.equal(client.getRoutingStatus().state, "matches-local-port");
	const routed = await fetch(`${feature}/api/automations/v1/capabilities`, {
		headers,
	});
	assert.equal(routed.status, 200);
	const capability = await routed.json();
	assert.equal(capability.workspaceId, "feature-workspace");
	assert.equal(capability.available, false); // Routing never supplies model readiness.
	assert.equal(
		(
			await fetch(`${unrelated}/api/automations/v1/capabilities`, {
				headers: { Authorization: "Bearer fixture-unrelated-key" },
			})
		).status,
		200,
	);
	client.disconnect();
	assert.equal(stopped, true);
	assert.equal(client.getRoutingStatus().state, "unverified");
	for (const secret of [
		"fixture-tunnel-token",
		"fixture-feature-key",
		"fixture-unrelated-key",
	])
		assert.equal(output.join("\n").includes(secret), false);
	const summary = {
		passed: true,
		connectorConnections: 4,
		wrongOriginDenied: true,
		localHealthIndependentOfRouting: true,
		correctedOriginIdentityMatches: true,
		unrelatedRuntimePreserved: true,
		modelReadinessStillUnavailable: true,
		credentialFreeLogs: true,
		cleanupStoppedConnector: stopped,
		limitations: [
			"Controlled cloudflared process and managed configuration; no real Cloudflare reconciliation",
			"Actual registered HTTP capability routes; no live model/provider or full bootstrap",
		],
	};
	const evidence = join(root, "summary.json");
	await writeFile(evidence, `${JSON.stringify(summary, null, 2)}\n`, {
		mode: 0o600,
	});
	log(JSON.stringify({ ...summary, evidence }, null, 2));
} finally {
	client?.disconnect();
	await Promise.all(servers.map((app) => app.close()));
	cloudflared.Tunnel.withToken = previousFactory;
	cloudflared.use(previousBin);
	console.log = log;
}
