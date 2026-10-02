// Run with Bun: actual frozen Hosted TS handlers + production runtime transports.
// No provider/model calls; authentication/storage are controlled injected dependencies.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { AutomationHttpGateway } from "../../packages/edge-worker/dist/automations/Gateway.js";
import { LatencyTrace } from "../../packages/edge-worker/dist/automations/Latency.js";
import { HttpSessionDeliveryTransport } from "../../packages/edge-worker/dist/sinks/SessionDeliveryTransport.js";
import { sessionDeliveryDigest } from "../../packages/edge-worker/dist/sinks/session-delivery.js";

export async function runHostedTimingDrive(hostedRoot) {
	assert.ok(hostedRoot, "Supply a frozen Hosted00847f21 checkout path");
	const load = (path) =>
		import(
			pathToFileURL(join(resolve(hostedRoot), "apps/app/src/lib", path)).href
		);
	const { createAutomationCallback } = await load(
		"customer-agents/automation-handler.ts",
	);
	const { createSessionDeliveryHandler } = await load(
		"agent-sessions/delivery-handler.ts",
	);
	const { RequestTimings } = await load("customer-agents/request-timings.ts");
	const hostedModules = {};
	for (const file of [
		"customer-agents/request-timings.ts",
		"customer-agents/automation-handler.ts",
		"agent-sessions/delivery-handler.ts",
	]) {
		hostedModules[file] = createHash("sha256")
			.update(
				await readFile(join(resolve(hostedRoot), "apps/app/src/lib", file)),
			)
			.digest("hex");
	}
	const key = "synthetic-supervisor-secret",
		workspace = randomUUID();
	const tuple = {
		contractVersion: 1,
		instanceId: randomUUID(),
		automationId: randomUUID(),
		revision: 1,
		occurrenceId: "a".repeat(64),
		attemptId: "attempt",
		fence: 1,
	};
	const item = {
		sessionId: "synthetic-session",
		sequence: 1,
		kind: "session",
		payload: {
			id: "synthetic-session",
			scopeRef: "synthetic-scope",
			role: "coordinator",
		},
	};
	const ack = {
		contractVersion: 1,
		sessionId: item.sessionId,
		sequence: 1,
		digest: sessionDeliveryDigest(item),
	};
	let denied = false,
		rejectAuth = false,
		badAck = false,
		pendingRelease,
		waitForRelease;
	const delay = (ms) => new Promise((r) => setTimeout(r, ms));
	const authenticate = async (request) => {
		await delay(2);
		return !rejectAuth &&
			request.headers.get("authorization") === `Bearer ${key}`
			? { teamId: workspace }
			: { error: "private auth", status: 401 };
	};
	let writes = 0,
		callbacks = 0;
	const receipts = new Map();
	const delivery = createSessionDeliveryHandler({
		authenticate,
		deliver: async ({ p_digest }) => {
			await delay(20);
			if (denied) throw Error("private storage failure");
			if (!receipts.has(p_digest)) {
				receipts.set(p_digest, ack);
				writes++;
			}
			return badAck
				? { ...ack, digest: "b".repeat(64) }
				: receipts.get(p_digest);
		},
	});
	const callback = createAutomationCallback({
		authenticate,
		event: async () => ({
			event_id: randomUUID(),
			input: "private synthetic input",
			revision: 1,
			trigger: "instruction",
		}),
		admit: async () => {
			await delay(20);
			return {
				authority: {},
				grantId: randomUUID(),
				expiresAt: new Date(Date.now() + 60000).toISOString(),
			};
		},
		interrupt: async () => ({
			contractVersion: 1,
			occurrenceId: tuple.occurrenceId,
			attemptId: tuple.attemptId,
			fence: 1,
			acknowledged: true,
		}),
		callback: async () => {
			callbacks++;
			await delay(20);
			if (waitForRelease) await waitForRelease;
			if (denied) throw Error("private callback failure");
			return { acknowledged: true };
		},
	});
	let mutation = "none";
	const seen = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const path = new URL(request.url).pathname;
			const result = path.endsWith("/deliver")
				? await delivery(request)
				: await callback(request, path.split("/").at(-1));
			seen.push({
				requested: request.headers.get("x-cyrus-latency-diagnostics"),
				marker: result.headers.get("x-cyrus-hosted-timing"),
				status: result.status,
			});
			if (mutation === "oversized")
				result.headers.set("server-timing", "x".repeat(1025));
			if (mutation === "unknown")
				result.headers.set("server-timing", "cyrus_private_customer;dur=3");
			if (mutation === "malformed")
				result.headers.set("server-timing", "cyrus_total;dur=NaN");
			if (mutation === "duplicate")
				result.headers.set(
					"server-timing",
					"cyrus_total;dur=1,cyrus_total;dur=2",
				);
			if (mutation === "marker")
				result.headers.set("x-cyrus-hosted-timing", "2");
			if (mutation === "absent") result.headers.delete("x-cyrus-hosted-timing");
			return result;
		},
	});
	const realFetch = globalThis.fetch;
	globalThis.fetch = async (url, options) => {
		assert.ok(
			String(url).startsWith("https://timing.fixture/"),
			"External network denied",
		);
		await delay(40); // Transport wait outside actual Hosted handler timing.
		return realFetch(
			String(url).replace(
				"https://timing.fixture",
				`http://127.0.0.1:${server.port}`,
			),
			options,
		);
	};
	const gateway = new AutomationHttpGateway(
		"https://timing.fixture",
		() => ({ apiKey: key, workspaceId: workspace }),
		true,
	);
	const transport = new HttpSessionDeliveryTransport(
		"https://timing.fixture",
		() => ({ apiKey: key, workspaceId: workspace }),
	);
	const signal = AbortSignal.timeout(20000);
	const resultBody = {
		...tuple,
		idempotencyKey: "b".repeat(64),
		text: "private synthetic output",
	};
	const traces = [];
	const collected = async (work) => {
		const trace = new LatencyTrace();
		await trace.run(work);
		trace.finish();
		const snapshot = trace.snapshot();
		traces.push(snapshot);
		return snapshot.spans.at(-1);
	};
	try {
		assert.deepEqual(await gateway.call("result", resultBody, signal), {
			acknowledged: true,
		});
		assert.deepEqual(seen.at(-1), {
			requested: null,
			marker: null,
			status: 200,
		});
		const result = await collected(async () =>
			assert.deepEqual(await gateway.call("result", resultBody, signal), {
				acknowledged: true,
			}),
		);
		assert.ok(result.hosted.cyrus_callback.durationMs >= 15);
		assert.ok(result.durationMs - result.hosted.cyrus_total.durationMs >= 35);
		assert.equal(result.hosted.cyrus_commit, undefined);
		for (let i = 0; i < 2; i++) {
			const span = await collected(async () =>
				assert.deepEqual(
					await transport.deliver({ ...tuple, item }, signal),
					ack,
				),
			);
			assert.ok(span.hosted.cyrus_commit.durationMs >= 15);
			assert.ok(span.durationMs - span.hosted.cyrus_total.durationMs >= 35);
		}
		assert.equal(writes, 1, "Immutable receipt replay");
		const definition = {
			id: tuple.automationId,
			workspaceId: workspace,
			ownerId: "owner",
			namespace: "customer:fixture",
			scopeRef: "customer:fixture",
			revision: 1,
			state: "enabled",
			role: "coordinator",
			instruction: "private synthetic instruction",
			schedule: null,
			target: { harness: "codex", model: "controlled" },
		};
		for (const phase of ["admit", "renew"]) {
			const span = await collected(() =>
				gateway.call(
					"authorize",
					{
						...tuple,
						definition,
						phase,
						occurrence: {
							id: tuple.occurrenceId,
							trigger: "instruction",
							scheduledAt: null,
							input: "private synthetic input",
						},
					},
					signal,
				),
			);
			assert.ok(span.hosted.cyrus_event);
			assert.ok(span.hosted.cyrus_admit);
		}
		const progress = await collected(() =>
			gateway.call("progress", { ...tuple, status: "running" }, signal),
		);
		assert.ok(progress.hosted.cyrus_callback);
		const interruption = await collected(() =>
			gateway.call("interrupt", tuple, signal),
		);
		assert.ok(interruption.hosted.cyrus_interrupt);
		for (const mode of [
			"oversized",
			"unknown",
			"malformed",
			"duplicate",
			"marker",
			"absent",
		]) {
			mutation = mode;
			const span = await collected(async () =>
				assert.deepEqual(await gateway.call("result", resultBody, signal), {
					acknowledged: true,
				}),
			);
			assert.equal(span.hosted, undefined, mode);
		}
		mutation = "none";
		denied = true;
		const failure = await collected(() =>
			assert.rejects(() => transport.deliver({ ...tuple, item }, signal)),
		);
		assert.equal(failure.hosted.cyrus_commit.flag, "failed");
		assert.equal(failure.failed, true);
		denied = false;
		rejectAuth = true;
		const unauthorized = await collected(() =>
			assert.rejects(() => gateway.call("result", resultBody, signal)),
		);
		assert.equal(unauthorized.hosted, undefined);
		assert.deepEqual(seen.at(-1), {
			requested: "1",
			marker: null,
			status: 401,
		});
		rejectAuth = false;
		badAck = true;
		await collected(() =>
			assert.rejects(() => transport.deliver({ ...tuple, item }, signal)),
		);
		badAck = false;
		waitForRelease = new Promise((r) => {
			pendingRelease = r;
		});
		let settled = false;
		const count = callbacks;
		const final = collected(() =>
			gateway.call("result", resultBody, signal),
		).then(() => {
			settled = true;
		});
		while (callbacks === count) await delay(5);
		await delay(30);
		assert.equal(settled, false);
		pendingRelease();
		await final;
		waitForRelease = undefined;
		let clock = 0;
		const capped = new RequestTimings(
			new Request("https://local.invalid", {
				headers: { "x-cyrus-latency-diagnostics": "1" },
			}),
			() => clock,
		);
		capped.authenticated();
		clock = 900000;
		const { readHostedTiming } = await import(
			"../../packages/edge-worker/dist/automations/HostedTiming.js"
		);
		assert.deepEqual(readHostedTiming(capped.respond({})), {
			cyrus_total: { durationMs: 600000, flag: "capped" },
		});
		const serialized = JSON.stringify(traces);
		assert.ok(!serialized.includes(key));
		assert.ok(!serialized.includes("private"));
		return {
			passed: true,
			hostedModules,
			requests: seen.length,
			uniqueSessionReceipts: writes,
			traces,
			limits: [
				"Actual frozen Hosted HTTP handlers/RequestTimings and runtime transports; gateway/storage/auth dependencies controlled",
				"Real loopback HTTP; no SQL/model/provider/live runtime access",
				"40ms transport injection is outside measured Hosted duration; overlap is not pure network latency",
			],
		};
	} finally {
		globalThis.fetch = realFetch;
		server.stop(true);
	}
}
if (
	process.argv[1] &&
	resolve(process.argv[1]) === new URL(import.meta.url).pathname
)
	console.log(
		JSON.stringify(await runHostedTimingDrive(process.argv[2]), null, 2),
	);
