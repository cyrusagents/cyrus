import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { AutomationRuntime } from "../src/automations/AutomationRuntime.js";
import { AutomationCheckpointStore } from "../src/automations/CheckpointStore.js";
import type { AutomationRegistration } from "../src/automations/contract.js";
import { AutomationHttpGateway } from "../src/automations/Gateway.js";
import { AutomationLedger } from "../src/automations/Ledger.js";
import {
	type SessionDeliveryEnvelope,
	sessionDeliveryDigest,
} from "../src/sinks/session-delivery.js";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0).reverse()) await fn();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});
async function fixture(mode: string | undefined = "current-admission-v1") {
	const root = await mkdtemp(join(tmpdir(), "delivery-authority-"));
	cleanup.push(() => rm(root, { recursive: true, force: true }));
	let now = Date.now();
	const ledger = new AutomationLedger(join(root, "ledger"), "w", () => now);
	cleanup.push(() => ledger.close());
	const store = new AutomationCheckpointStore(join(root, "checkpoints"));
	const definition: AutomationRegistration = {
		id: "d",
		workspaceId: "w",
		ownerId: "o",
		namespace: "n",
		scopeRef: "s",
		revision: 1,
		state: "enabled",
		role: "coordinator",
		instruction: "Reply",
		schedule: null,
		target: { harness: "claude", model: "fixture" },
	};
	ledger.upsert(definition);
	const occurrence = ledger.enqueue("d", 1, "e", "Hello");
	const state = {
		mode,
		auth: 0,
		models: 0,
		results: 0,
		progress: 0,
		committed: false,
		failModel: false,
		loseResult: false,
		revoked: false,
		badAck: false,
		credentialTtl: 60000,
		renewMode: false,
		firstDeliveryAuth: 0,
		saved: false,
		beforeSave: undefined as undefined | (() => void),
		onModel: undefined as undefined | ((signal: AbortSignal) => Promise<void>),
		onDelivery: undefined as
			| undefined
			| ((e: SessionDeliveryEnvelope) => Promise<void>),
	};
	const receipts = new Map<number, string>();
	const deliveries: SessionDeliveryEnvelope[] = [];
	const save = store.save.bind(store);
	store.save = async (value) => {
		await save(value);
		if (!state.saved) {
			state.saved = true;
			state.beforeSave?.();
		}
	};
	const options = {
		workspaceId: () => "w",
		ledger,
		store,
		readiness: () => ({ ...definition.target, reason: null }),
		renewMilliseconds: 100000,
		sessions: {
			directory: join(root, "sessions"),
			secrets: () => [],
			transport: {
				async deliver(e: SessionDeliveryEnvelope) {
					if (!state.firstDeliveryAuth) state.firstDeliveryAuth = state.auth;
					if (state.revoked) throw Error("Hosted current authority denied");
					deliveries.push(e);
					await state.onDelivery?.(e);
					const hash = sessionDeliveryDigest(e.item);
					if (receipts.has(e.item.sequence))
						expect(receipts.get(e.item.sequence)).toBe(hash);
					else {
						expect(state.committed).toBe(false);
						expect(e.item.sequence).toBe(receipts.size + 1);
						receipts.set(e.item.sequence, hash);
					}
					return {
						contractVersion: 1 as const,
						sessionId: e.item.sessionId,
						sequence: e.item.sequence,
						digest: state.badAck ? "0".repeat(64) : hash,
					};
				},
			},
		},
		tools: () => ({
			close: async () => {},
			call: async () => ({}),
			renew: async (fn: () => Promise<void>) => fn(),
		}),
		model: {
			async next(_messages: unknown, _authority: unknown, signal: AbortSignal) {
				state.models++;
				if (state.failModel) throw Error("Interrupted");
				await state.onModel?.(signal);
				return { type: "result" as const, text: "Hello" };
			},
		},
		gateway: {
			async call(endpoint: string, body: Record<string, unknown>) {
				if (state.revoked) throw Error("Authority revoked");
				if (endpoint === "authorize") {
					state.auth++;
					const expiresAt = new Date(Date.now() + 60000).toISOString();
					return {
						authority: {
							contractVersion: 1,
							definition: { ...definition, grants: [] },
							occurrenceId: occurrence.id,
							attemptId: body.attemptId,
							fence: body.fence,
							leaseUntil: expiresAt,
							phase: state.committed ? "reconcile" : "execute",
							input: occurrence.input,
						},
						mcp: {
							token: "synthetic-private-credential-only-fixture",
							audience: "/mcp",
							expiresAt: new Date(
								Date.parse(expiresAt) - 60000 + state.credentialTtl,
							).toISOString(),
							grantId: "g",
						},
						...(state.mode !== undefined && {
							sessionDeliveryAuthority:
								state.renewMode && state.auth > 2 ? "future-v2" : state.mode,
						}),
						sessionDelivery: {
							contractVersion: 1,
							path: "/api/agent-sessions/v1/deliver",
							session: { id: "session", scopeRef: "s", role: "coordinator" },
						},
					};
				}
				if (endpoint === "progress") {
					state.progress++;
					return {};
				}
				state.results++;
				expect(receipts.size).toBeGreaterThan(0);
				state.committed = true;
				if (state.loseResult) {
					state.loseResult = false;
					throw Error("Lost result ACK");
				}
				return {
					contractVersion: 1,
					acknowledged: true,
					occurrenceId: body.occurrenceId,
					idempotencyKey: body.idempotencyKey,
				};
			},
		},
	};
	const runtimes: AutomationRuntime[] = [];
	const create = () => {
		const r = new AutomationRuntime(options);
		runtimes.push(r);
		return r;
	};
	cleanup.push(async () => {
		for (const r of runtimes) await r.stop();
	});
	return {
		state,
		store,
		ledger,
		occurrence,
		receipts,
		deliveries,
		options,
		create,
		advance: () => {
			now += 11000;
		},
	};
}
it.each([
	undefined,
	"future-v2",
	"current-admission-v1",
])("uses only exact negotiated delivery mode: %s", async (mode) => {
	const f = await fixture(mode);
	f.state.mode = mode;
	f.options.renewMilliseconds = 100000;
	await f.create().wake();
	expect(
		f.ledger.status("d").occurrences[0]?.status,
		JSON.stringify({
			state: f.state,
			history: f.ledger.status("d").occurrences[0]?.failureHistory,
		}),
	).toBe("completed");
	expect(f.state.firstDeliveryAuth).toBe(
		mode === "current-admission-v1" ? 2 : 3,
	);
	expect(f.state.models).toBe(1);
	expect(f.state.progress).toBe(1);
	expect(f.state.auth).toBeGreaterThan(3); // model/progress/result gates remain
});
it.each([
	"lease-expired",
	"credential-expired",
	"aborted",
	"receiver-revoked",
	"wrong-ack",
])("fails closed before model on %s", async (failure) => {
	const f = await fixture();
	const r = f.create();
	if (failure === "lease-expired")
		f.state.beforeSave = () => {
			const later = Date.now() + 61000;
			vi.spyOn(Date, "now").mockReturnValue(later);
		};
	if (failure === "credential-expired") {
		f.state.credentialTtl = 10000;
		f.state.beforeSave = () => {
			const later = Date.now() + 11000;
			vi.spyOn(Date, "now").mockReturnValue(later);
		};
	}
	if (failure === "aborted")
		f.state.beforeSave = () => {
			void r.stop();
		};
	if (failure === "receiver-revoked")
		f.state.onDelivery = async () => {
			throw Error("Paused on receiver");
		};
	if (failure === "wrong-ack") f.state.badAck = true;
	await r.wake();
	expect(f.state.models).toBe(0);
	expect(f.state.results).toBe(0);
	if (["lease-expired", "credential-expired", "aborted"].includes(failure))
		expect(f.deliveries).toHaveLength(0);
});
it.each([
	["current-admission-v1", undefined],
	[undefined, "current-admission-v1"],
	["current-admission-v1", "future-v2"],
	["future-v2", "current-admission-v1"],
])("pins checkpoint mode %s across resume to %s", async (before, after) => {
	const f = await fixture(before);
	f.state.mode = before;
	f.state.failModel = true;
	const first = f.create();
	await first.wake();
	await first.stop();
	expect(f.state.models).toBe(1);
	const delivered = f.deliveries.length;
	f.state.failModel = false;
	f.state.mode = after;
	f.advance();
	await f.create().wake();
	expect(f.state.models).toBe(1);
	expect(f.deliveries).toHaveLength(delivered);
	expect(f.state.results).toBe(0);
});
it("denies a changed mode on renewal", async () => {
	const f = await fixture();
	f.state.renewMode = true;
	await f.create().wake();
	expect(f.state.models).toBe(0);
	expect(f.state.results).toBe(0);
});
it("keeps periodic current-authority revocation during model work", async () => {
	const f = await fixture();
	f.options.renewMilliseconds = 10;
	f.state.onModel = (signal) =>
		new Promise((resolve) => {
			f.state.revoked = true;
			signal.addEventListener("abort", () => resolve(), { once: true });
		});
	await f.create().wake();
	expect(f.state.models).toBe(1);
	expect(f.state.results).toBe(0);
});
it("flushes exact ordered receipts before result and recovers lost result ACK without reopening model", async () => {
	const f = await fixture();
	f.state.loseResult = true;
	let release!: () => void;
	let entered!: () => void;
	const enteredPromise = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	f.state.onDelivery = async (e) => {
		if (e.item.kind === "lifecycle" && e.item.payload.status === "complete") {
			entered();
			await gate;
		}
	};
	const r = f.create();
	const running = r.wake();
	await enteredPromise;
	expect(f.state.results).toBe(0);
	release();
	await running;
	await r.stop();
	expect(f.state.models).toBe(1);
	expect(f.state.results).toBe(1);
	const saved = [...f.receipts];
	f.advance();
	await f.create().wake();
	expect(f.state.models).toBe(1);
	expect(f.state.progress).toBe(1);
	expect(f.state.results).toBe(2);
	expect([...f.receipts]).toEqual(saved);
	expect(f.ledger.status("d").occurrences[0]?.status).toBe("completed");
});
it.each([
	false,
	true,
])("negotiates only alongside session delivery: %s", async (enabled) => {
	const fetcher = vi.fn(async (_url, options) => {
		const h = new Headers(options.headers);
		expect(h.get("X-Cyrus-Session-Delivery-Authority")).toBe(
			enabled ? "1" : null,
		);
		expect(h.get("X-Cyrus-Session-Delivery")).toBe(enabled ? "1" : null);
		return new Response("{}");
	});
	vi.stubGlobal("fetch", fetcher);
	const gateway = new AutomationHttpGateway(
		"https://fixture.invalid",
		() => ({ apiKey: "fixture", workspaceId: "w" }),
		enabled,
	);
	await gateway.call("authorize", {}, new AbortController().signal);
	expect(fetcher).toHaveBeenCalledTimes(1);
});
