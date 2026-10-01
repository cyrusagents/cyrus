// Test-only runtime half of production dispatcher -> engineering -> parent join.
// Hosted owns /fixture/dispatch and SQL. This driver never submits definitions or
// occurrences: it only exposes the installed registered routes and observes them.

import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { nativeOracle } from "./oracle-native.mjs";

const [directory, modules] = process.argv.slice(2);
const f = JSON.parse(await readFile(join(directory, "fixture.json"), "utf8"));
assert.match(f.runtimeSha ?? "", /^[a-f0-9]{40}$/);
const manifest = JSON.parse(
	await readFile(join(modules, "../../package.json"), "utf8"),
);
assert.equal(manifest.cyrusLocalTestArtifact.sourceSha, f.runtimeSha);
assert.equal(f.definition.workspaceId, f.parentDefinition.workspaceId);
assert.equal(f.definition.role, "engineering");
assert.equal(f.parentDefinition.role, "coordinator");
assert.notEqual(f.definition.id, f.parentDefinition.id);
assert.match(f.findingsMarker ?? "", /^[A-Z0-9_]{8,80}$/);
const origin = new URL(f.origin);
assert.equal(origin.hostname, "127.0.0.1");
assert.equal(origin.protocol, "http:");
assert.equal(origin.pathname, "/");
assert.equal(
	origin.username + origin.password + origin.search + origin.hash,
	"",
);
const load = (name) => import(pathToFileURL(join(modules, `${name}.js`)).href);
const Fastify = createRequire(join(modules, "register.js"))("fastify");
const { AutomationRuntime } = await load("AutomationRuntime");
const { AutomationLedger } = await load("Ledger");
const { AutomationCheckpointStore } = await load("CheckpointStore");
const { AutomationHttpGateway } = await load("Gateway");
const { ScopedAutomationMcpClient } = await load("ScopedMcpClient");
const { registerAutomationRoutes } = await load("register");
const { DockerSandbox } = await load("../customer-runtime/DockerSandbox");
const { HttpSessionDeliveryTransport } = await load(
	"../sinks/SessionDeliveryTransport",
);
const nativeFetch = globalThis.fetch;
globalThis.fetch = (url, init) => {
	const u = new URL(url);
	assert.equal(u.origin, "https://engineering-fixture.invalid");
	return nativeFetch(new URL(u.pathname, origin), init);
};
const ledger = new AutomationLedger(
	join(directory, "ledger"),
	f.definition.workspaceId,
);
const credentials = () => ({
	apiKey: f.supervisor,
	workspaceId: f.definition.workspaceId,
});
const gateway = new AutomationHttpGateway(
	"https://engineering-fixture.invalid",
	credentials,
	true,
	() => true,
);
let steps = 0;
const parentOccurrences = new Set();
let parentSteps = 0;
const commandExitCodes = [];
let sends = 0;
let lostAck = false;
const runtime = new AutomationRuntime({
	workspaceId: () => f.definition.workspaceId,
	ledger,
	gateway: {
		async call(endpoint, body, signal) {
			const result = await gateway.call(endpoint, body, signal);
			if (endpoint === "result") {
				sends++;
				if (!lostAck && body.automationId === f.definition.id) {
					lostAck = true;
					throw new Error("Controlled lost Hosted result ACK");
				}
			}
			return result;
		},
	},
	sessions: {
		directory: join(directory, "sessions"),
		secrets: () => [f.supervisor],
		transport: new HttpSessionDeliveryTransport(
			"https://engineering-fixture.invalid",
			credentials,
		),
	},
	store: new AutomationCheckpointStore(join(directory, "checkpoints")),
	readiness: () => ({
		reason: null,
		harness: f.definition.target.harness,
		model: f.definition.target.model,
	}),
	engineering: {
		available: () => true,
		sandbox: () => {
			const sandbox = new DockerSandbox({
				image: f.image,
				dockerPath: f.dockerPath,
				dockerHost: f.dockerHost,
				javascriptRuntime: "node",
			});
			return {
				start: (...a) => sandbox.start(...a),
				snapshot: (...a) => sandbox.snapshot(...a),
				stop: () => sandbox.stop(),
				async execute(...a) {
					const result = await sandbox.execute(...a);
					commandExitCodes.push(result.exitCode);
					return result;
				},
			};
		},
	},
	model: await nativeOracle(
		{
			async next(messages, authority) {
				if (authority.definition.role === "coordinator") {
					assert.equal(authority.definition.id, f.parentDefinition.id);
					assert.equal(
						authority.definition.workspaceId,
						f.parentDefinition.workspaceId,
					);
					assert.equal(
						authority.definition.scopeRef,
						f.parentDefinition.scopeRef,
					);
					assert.ok(
						!parentOccurrences.has(authority.occurrenceId),
						"result-only recovery must not reopen the parent model",
					);
					const input = messages[0].content;
					assert.ok(
						input.includes("engineering.result"),
						"parent input came from a scoped result event",
					);
					assert.ok(!input.includes("FOREIGN_CUSTOMER_SENTINEL"));
					assert.ok(
						input.includes(f.findingsMarker) ||
							input.includes("https://github.com/fixture/repo/pull/7"),
						"parent sees persisted findings or publication evidence",
					);
					parentOccurrences.add(authority.occurrenceId);
					parentSteps++;
					return {
						type: "result",
						text: input.includes(f.findingsMarker)
							? `Parent received ${f.findingsMarker}; outcome still needs verification.`
							: "Parent received the reviewed PR https://github.com/fixture/repo/pull/7; outcome still needs verification.",
					};
				}
				steps++;
				assert.equal(authority.definition.role, "engineering");
				assert.deepEqual(authority.definition.grants, []);
				assert.equal(JSON.stringify(messages).includes("PRIVATE"), false);
				const position = messages.filter((m) => m.role === "assistant").length;
				const check =
					"node -e \"require('node:assert').equal(require('node:fs').readFileSync('index.ts','utf8'),'export const n=2')\"";
				if (position === 0)
					return {
						type: "tool",
						call: { name: "execute", arguments: { command: check } },
					};
				if (position === 1)
					return {
						type: "tool",
						call: {
							name: "execute",
							arguments: {
								command: `node -e "require('node:fs').writeFileSync('index.ts','export const n=2')" && ${check}`,
							},
						},
					};
				if (position === 2)
					return {
						type: "tool",
						call: {
							name: "publish_artifact",
							arguments: {
								title: "Synthetic repair",
								summary: "Synthetic reproduction and tests",
							},
						},
					};
				return {
					type: "result",
					text: `${f.findingsMarker}: Synthetic repair tested and published; outcome still needs verification.`,
				};
			},
		},
		{ directory, modules, load },
	),
	tools: (authority, credential, signal) =>
		new ScopedAutomationMcpClient(
			"https://engineering-fixture.invalid",
			authority,
			credential,
			signal,
		),
});
const app = Fastify({ logger: false });
registerAutomationRoutes(app, runtime, () => f.supervisor);
try {
	const address = await app.listen({ host: "127.0.0.1", port: 0 });
	const request = (path, body, authorized = true) =>
		nativeFetch(`${address}/api/automations/v1/${path}`, {
			signal: AbortSignal.timeout(10_000),
			method: body ? "POST" : "GET",
			headers: {
				...(authorized ? { authorization: `Bearer ${f.supervisor}` } : {}),
				"content-type": "application/json",
			},
			...(body ? { body: JSON.stringify(body) } : {}),
		});
	assert.equal((await request("capabilities", null, false)).status, 401);
	const capabilities = await (await request("capabilities")).json();
	assert.equal(capabilities.available, true);
	assert.equal(capabilities.capabilities.engineering, true);
	const dispatch = async () => {
		const response = await nativeFetch(new URL("/fixture/dispatch", origin), {
			signal: AbortSignal.timeout(10_000),
			method: "POST",
			headers: {
				authorization: `Bearer ${f.supervisor}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ origin: address }),
		});
		assert.equal(response.status, 200);
		return response.json();
	};
	const start = Date.now();
	let completed = false;
	let proof;
	let parentStatus;
	while (Date.now() - start < 90_000) {
		proof = await dispatch();
		const engineering = await request(`status/${f.definition.id}`);
		const parents = await request(`status/${f.parentDefinition.id}`);
		if (engineering.ok && parents.ok) {
			const engineeringStatus = await engineering.json();
			parentStatus = await parents.json();
			if (
				proof.done === true &&
				engineeringStatus.occurrences.some((o) => o.status === "completed") &&
				parentStatus.occurrences.filter((o) => o.status === "completed")
					.length === proof.parentEventCount
			) {
				completed = true;
				break;
			}
			assert.ok(
				!engineeringStatus.occurrences.some((o) => o.status === "blocked"),
				"engineering blocked",
			);
			assert.ok(
				!parentStatus.occurrences.some((o) => o.status === "blocked"),
				"parent blocked",
			);
		}
		await new Promise((r) => setTimeout(r, 250));
	}
	assert.equal(completed, true);
	assert.ok(
		Number.isInteger(proof.parentEventCount) && proof.parentEventCount > 0,
	);
	assert.equal(parentSteps, proof.parentEventCount);
	assert.equal(parentOccurrences.size, proof.parentEventCount);
	assert.equal(proof.productionDispatcher, true);
	assert.equal(proof.occurrenceAckLost, true);
	assert.equal(proof.duplicateDispatchDeduplicated, true);
	assert.equal(proof.foreignCustomerDenied, true);
	assert.equal(proof.withdrawnSponsorDenied, true);
	assert.equal(proof.pausedCustomerDenied, true);
	assert.equal(proof.publications, 1);
	assert.equal(steps, 4);
	assert.deepEqual(commandExitCodes, [1, 0]);
	assert.equal(sends, 2 + parentSteps);
	assert.equal(lostAck, true);
	await writeFile(
		join(directory, "summary.json"),
		JSON.stringify({
			passed: true,
			node: process.version,
			registeredEntryPoint: true,
			automaticLostAckRecovery: true,
			completed: 1 + parentSteps,
			parentOccurrences: parentOccurrences.size,
			parentModelSteps: parentSteps,
			productionDispatcher: proof,
			modelSteps: steps,
			resultTransmissions: sends,
			commandExitCodes,
			image: f.image,
			elapsedMs: Date.now() - start,
		}),
		{ mode: 0o600 },
	);
} finally {
	await runtime.stop();
	await app.close();
	ledger.close();
}
