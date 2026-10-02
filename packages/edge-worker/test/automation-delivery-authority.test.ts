import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { AutomationRuntime } from "../src/automations/AutomationRuntime.js";
import { AutomationCheckpointStore } from "../src/automations/CheckpointStore.js";
import type { AutomationRegistration } from "../src/automations/contract.js";
import { AutomationHttpGateway } from "../src/automations/Gateway.js";
import { AutomationLedger } from "../src/automations/Ledger.js";
import type { AutomationModelContext } from "../src/automations/Model.js";
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
		lifecycle: undefined as string | undefined,
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
		onGateway: undefined as undefined | ((endpoint: string) => void),
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
				state.onGateway?.(endpoint);
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
						...(state.lifecycle !== undefined && {
							lifecycleAuthority: state.lifecycle,
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
	"legacy",
	"unknown",
	"joined",
	"revoked",
	"aborted",
])("keeps model effects behind current authority at entry: %s", async (mode) => {
	const f = await fixture();
	let enter!: () => void;
	const entered = new Promise<void>((resolve) => {
		enter = resolve;
	});
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let held = false,
		modelEntry = 0,
		effects = 0,
		authRequests = 0;
	const call = f.options.gateway.call;
	f.options.gateway.call = async (endpoint, body) => {
		if (endpoint === "authorize") {
			authRequests++;
			if (f.state.progress && !held) {
				held = true;
				enter();
				await gate;
			}
		}
		return call(endpoint, body);
	};
	Object.assign(f.options.model, {
		...(mode !== "legacy" && {
			nextAuthorization: mode === "unknown" ? "future-v2" : "in-flight-v1",
		}),
		async open(context: AutomationModelContext) {
			return {
				async next() {
					modelEntry++;
					await context.authorize();
					context.signal.throwIfAborted();
					effects++;
					// A later invocation still makes a NEW current check.
					const before = authRequests;
					await context.authorize();
					expect(authRequests).toBe(before + 1);
					return { type: "result" as const, text: "Authorized" };
				},
			};
		},
	});
	const runtime = f.create();
	const running = runtime.wake();
	await entered;
	await new Promise((resolve) => setImmediate(resolve));
	expect(modelEntry).toBe(mode === "legacy" || mode === "unknown" ? 0 : 1);
	expect(effects).toBe(0);
	if (mode === "revoked") f.state.revoked = true;
	const stopping = mode === "aborted" ? runtime.stop() : undefined;
	release();
	await running;
	await stopping;
	expect(effects).toBe(mode === "revoked" || mode === "aborted" ? 0 : 1);
	expect(f.state.results).toBe(
		mode === "revoked" || mode === "aborted" ? 0 : 1,
	);
});

it.each([
	"joined",
	"revoked",
	"aborted",
	"settled",
	"legacy",
	"unknown",
])("keeps fresh context preparation and model entry behind current authority: %s", async (mode) => {
	const f = await fixture();
	f.state.lifecycle = "current-action-v1";
	const nativeContext = {
		contractVersion: 1,
		bindingId: "g",
		scopeRef: "s",
		permissions: ["read"],
	};
	const call = f.options.gateway.call;
	f.options.gateway.call = async (endpoint, body) => ({
		...(await call(endpoint, body)),
		...(endpoint === "authorize" && { nativeContext }),
	});
	let release!: () => void, entered!: () => void, prepared!: () => void;
	const gate = new Promise<void>((r) => {
		release = r;
	});
	const pending = new Promise<void>((r) => {
		entered = r;
	});
	const localPrepared = new Promise<void>((r) => {
		prepared = r;
	});
	let reads = 0,
		checks = 0,
		postContext = 0,
		entries = 0,
		effects = 0;
	f.options.tools = () => ({
		close: async () => {},
		renew: async (fn: () => Promise<void>) => fn(),
		revalidate: async () => {
			checks++;
			if (reads && !postContext) {
				postContext = checks;
				entered();
				if (mode !== "settled") await gate;
			}
			if (f.state.revoked) throw Error("Current source withdrawn");
		},
		call: async () => {
			reads++;
			return { items: [{ text: "fresh scoped context" }], nextCursor: null };
		},
	});
	const save = f.store.save.bind(f.store);
	f.store.save = async (state) => {
		await save(state);
		if (reads) prepared();
	};
	Object.assign(f.options.model, {
		...(mode !== "legacy" && {
			nextAuthorization: mode === "unknown" ? "future-v2" : "in-flight-v1",
		}),
		async open(context: AutomationModelContext) {
			return {
				async next() {
					entries++;
					await context.authorize();
					context.signal.throwIfAborted();
					effects++;
					return { type: "result" as const, text: "Used current context" };
				},
			};
		},
	});
	const runtime = f.create();
	const running = runtime.wake();
	try {
		await pending;
		if (mode !== "legacy" && mode !== "unknown") {
			await Promise.race([
				localPrepared,
				new Promise((_, reject) =>
					setTimeout(
						() =>
							reject(Error("Local preparation serialized behind remote check")),
						500,
					),
				),
			]);
			await new Promise((r) => setImmediate(r));
			expect(entries).toBe(1);
			if (mode !== "settled") {
				expect(effects).toBe(0);
				expect(checks).toBe(postContext);
				expect(
					f.deliveries.some(
						(e) =>
							e.item.kind === "activity" &&
							"result" in e.item.payload.content &&
							e.item.payload.content.result !== null,
					),
				).toBe(false);
			}
		} else {
			expect(entries).toBe(0);
		}
		if (mode === "revoked") f.state.revoked = true;
		const stopping = mode === "aborted" ? runtime.stop() : undefined;
		release();
		await running;
		await stopping;
		expect(effects).toBe(mode === "revoked" || mode === "aborted" ? 0 : 1);
		expect(f.state.results).toBe(effects);
		// Fast checks cannot be kept as a permission cache for model entry.
		if (mode === "settled") expect(checks).toBeGreaterThan(postContext);
	} finally {
		release();
		await running;
	}
});

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
	f.state.lifecycle = "current-action-v1";
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
		expect(h.get("X-Cyrus-Lifecycle-Authority")).toBe(enabled ? "1" : null);
		expect(h.get("X-Cyrus-Context-Read-Authority")).toBe(enabled ? "1" : null);
		expect(h.get("X-Cyrus-Slack-Messages")).toBe(enabled ? "1" : null);
		expect(h.get("X-Cyrus-Native-Work-Details")).toBe(enabled ? "1" : null);
		return new Response("{}");
	});
	vi.stubGlobal("fetch", fetcher);
	const gateway = new AutomationHttpGateway(
		"https://fixture.invalid",
		() => ({ apiKey: "fixture", workspaceId: "w" }),
		enabled,
	);
	for (const phase of ["admit", "renew"])
		await gateway.call("authorize", { phase }, new AbortController().signal);
	expect(fetcher).toHaveBeenCalledTimes(2);
});

it("uses fresh authoritative lifecycle handlers only with exact negotiation", async () => {
	const calls: number[] = [];
	for (const mode of [undefined, "future-v2", "current-action-v1"]) {
		const f = await fixture();
		f.state.lifecycle = mode;
		await f.create().wake();
		expect(f.ledger.status("d").occurrences[0]?.status).toBe("completed");
		expect(f.state.models).toBe(1);
		expect(f.state.progress).toBe(1);
		expect(f.state.results).toBe(1);
		calls.push(f.state.auth);
	}
	expect(calls[1]).toBe(calls[0]);
	// Progress and the two terminal callback barriers use their own server checks.
	expect(calls[2]).toBe(calls[0]! - 3);
});
it.each([
	"progress",
	"result",
])("denies revoked current lifecycle handler: %s", async (endpoint) => {
	const f = await fixture();
	f.state.lifecycle = "current-action-v1";
	let reached = false;
	f.state.onGateway = (current) => {
		if (current === endpoint) {
			reached = true;
			if (endpoint === "result") expect(f.receipts.size).toBeGreaterThan(0);
			f.state.revoked = true;
		}
	};
	await f.create().wake();
	expect(reached).toBe(true); // Actual server action, not a cached permission.
	expect(f.state.models).toBe(endpoint === "progress" ? 0 : 1);
	expect(f.state.committed).toBe(false);
	expect(f.state.results).toBe(0);
});
it.each([
	"expired",
	"near-expiry",
	"revoked",
])("rechecks the lifecycle boundary after final ACK: %s", async (failure) => {
	const f = await fixture();
	f.state.lifecycle = "current-action-v1";
	let beforeAck = 0;
	f.state.onDelivery = async (e) => {
		if (e.item.kind === "lifecycle" && e.item.payload.status === "complete") {
			beforeAck = f.state.auth;
			if (failure === "revoked") f.state.revoked = true;
			else {
				const later = Date.now() + (failure === "expired" ? 61000 : 50000);
				vi.spyOn(Date, "now").mockReturnValue(later);
			}
		}
	};
	await f.create().wake();
	expect(beforeAck).toBeGreaterThan(0);
	expect(f.state.committed).toBe(failure === "near-expiry");
	if (failure === "near-expiry")
		expect(f.state.auth).toBeGreaterThan(beforeAck);
	if (failure === "expired") expect(f.state.results).toBe(0);
});
it.each([
	false,
	true,
])("keeps periodic revocation under lifecycle optimization: %s", async (optimized) => {
	const f = await fixture();
	f.state.lifecycle = optimized ? "current-action-v1" : undefined;
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
it("schedules the watchdog from the latest real authority check and still revokes a held final ACK", async () => {
	const f = await fixture();
	f.state.lifecycle = "current-action-v1";
	f.options.renewMilliseconds = 5000;
	const modelEntered = Promise.withResolvers<void>();
	const modelRelease = Promise.withResolvers<void>();
	const receiptEntered = Promise.withResolvers<void>();
	const receiptRelease = Promise.withResolvers<void>();
	let signal!: AbortSignal;
	f.state.onModel = async (current) => {
		signal = current;
		current.addEventListener(
			"abort",
			() => {
				modelRelease.resolve();
				receiptRelease.resolve();
			},
			{ once: true },
		);
		modelEntered.resolve();
		await modelRelease.promise;
	};
	f.state.onDelivery = async (e) => {
		if (e.item.kind === "lifecycle" && e.item.payload.status === "complete") {
			receiptEntered.resolve();
			await receiptRelease.promise;
		}
	};
	vi.useFakeTimers({
		toFake: [
			"setTimeout",
			"setInterval",
			"clearTimeout",
			"clearInterval",
			"performance",
		],
	});
	const runtime = f.create();
	const work = runtime.wake();
	try {
		await modelEntered.promise;
		await vi.advanceTimersByTimeAsync(4000);
		modelRelease.resolve();
		await receiptEntered.promise;
		const checkedBeforeReceipt = f.state.auth;
		await vi.advanceTimersByTimeAsync(1500);
		// The old fixed timer fires at5000 even though the result boundary
		// already made a real current check at4000. No action reuses that check.
		expect(f.state.auth).toBe(checkedBeforeReceipt);
		expect(signal.aborted).toBe(false);
		f.state.revoked = true;
		await vi.advanceTimersByTimeAsync(3500);
		expect(signal.aborted).toBe(true);
		await work;
		expect(f.state.results).toBe(0);
	} finally {
		modelRelease.resolve();
		receiptRelease.resolve();
		await runtime.stop();
		await work;
		vi.useRealTimers();
	}
});
it("requires current session delivery for lifecycle negotiation", async () => {
	const f = await fixture();
	f.state.mode = undefined;
	f.state.lifecycle = "current-action-v1";
	await f.create().wake();
	expect(f.state.models).toBe(0);
	expect(f.state.progress).toBe(0);
});
it("denies changed lifecycle negotiation during a current renewal", async () => {
	const f = await fixture();
	f.state.lifecycle = "current-action-v1";
	f.state.onModel = async () => {
		f.state.lifecycle = "future-v2";
	};
	await f.create().wake();
	expect(f.state.models).toBe(1);
	expect(f.state.results).toBe(0);
});
it.each([
	undefined,
	"current-action-v1",
])("recovers immutable result ACK without model reopen, old mode: %s", async (original) => {
	const f = await fixture();
	f.state.lifecycle = original;
	f.state.loseResult = true;
	const first = f.create();
	await first.wake();
	await first.stop();
	expect(f.state.results).toBe(1);
	const receipts = [...f.receipts];
	const previousAuth = f.state.auth;
	f.state.lifecycle = "current-action-v1";
	f.advance();
	await f.create().wake();
	expect(f.state.models).toBe(1);
	expect(f.state.results).toBe(2);
	expect([...f.receipts]).toEqual(receipts);
	expect(f.ledger.status("d").occurrences[0]?.status).toBe("completed");
	// Old checkpoints retain both terminal preflights even after server upgrade.
	expect(f.state.auth - previousAuth).toBe(original === undefined ? 5 : 3);
});
it("pins stored lifecycle mode across checkpoint recovery", async () => {
	const f = await fixture();
	f.state.lifecycle = "current-action-v1";
	f.state.failModel = true;
	const first = f.create();
	await first.wake();
	await first.stop();
	f.state.failModel = false;
	f.state.lifecycle = undefined;
	f.advance();
	await f.create().wake();
	expect(f.state.models).toBe(1);
	expect(f.state.results).toBe(0);
});

async function contextReadFixture(mode: string | undefined) {
	const f = await fixture();
	f.state.lifecycle = "current-action-v1";
	const context = {
		mode,
		reads: 0,
		checks: 0,
		checksBeforeRead: [] as number[],
		revokeAfterRead: false,
		revokeBeforeRead: false,
	};
	const gateway = f.options.gateway.call;
	f.options.gateway.call = async (endpoint, body) => ({
		...(await gateway(endpoint, body)),
		...(endpoint === "authorize" && {
			nativeContext: {
				contractVersion: 1,
				bindingId: "g",
				scopeRef: "s",
				permissions: ["read"],
			},
			...(context.mode !== undefined && { contextReadAuthority: context.mode }),
		}),
	});
	f.state.onGateway = (endpoint) => {
		if (endpoint === "progress") {
			context.checks = 0;
			if (context.revokeBeforeRead) f.state.revoked = true;
		}
	};
	f.options.tools = () => ({
		close: async () => {},
		renew: async (fn: () => Promise<void>) => fn(),
		revalidate: async () => {
			context.checks++;
			if (f.state.revoked) throw Error("Source withdrawn");
		},
		call: async () => {
			context.checksBeforeRead.push(context.checks);
			if (f.state.revoked) throw Error("Current invocation denied");
			context.reads++;
			if (context.revokeAfterRead) f.state.revoked = true;
			return { items: [{ text: "current context" }], nextCursor: null };
		},
	});
	return { ...f, context };
}
it.each([
	undefined,
	"future-v2",
	"current-call-v1",
])("negotiates only the exact automatic context read mode: %s", async (mode) => {
	const f = await contextReadFixture(mode);
	await f.create().wake();
	expect(f.state.results).toBe(1);
	expect(f.context.reads).toBe(1);
	expect(f.context.checksBeforeRead).toEqual([
		mode === "current-call-v1" ? 0 : 1,
	]);
	expect(f.context.checks).toBeGreaterThan(f.context.checksBeforeRead[0]!);
});
it.each([
	"before",
	"after",
])("withholds context/model output after withdrawal %s negotiated read", async (when) => {
	const f = await contextReadFixture("current-call-v1");
	f.context.revokeBeforeRead = when === "before";
	f.context.revokeAfterRead = when === "after";
	await f.create().wake();
	expect(f.state.models).toBe(0);
	expect(f.state.results).toBe(0);
	expect(f.context.reads).toBe(when === "before" ? 0 : 1);
	expect(
		f.deliveries.some(
			(e) =>
				e.item.kind === "activity" &&
				"result" in e.item.payload.content &&
				e.item.payload.content.result !== null,
		),
	).toBe(false);
});
it("renews near expiry and denies a changed context read mode", async () => {
	const f = await contextReadFixture("current-call-v1");
	f.state.credentialTtl = 10000;
	f.state.onGateway = (endpoint) => {
		if (endpoint === "progress") f.context.mode = "future-v2";
	};
	await f.create().wake();
	expect(f.state.auth).toBeGreaterThan(1);
	expect(f.context.reads).toBe(0);
	expect(f.state.models).toBe(0);
});
it.each([
	undefined,
	"current-call-v1",
])("preserves old/checkpoint context read mode on recovery: %s", async (original) => {
	const f = await contextReadFixture(original);
	f.state.failModel = true;
	const first = f.create();
	await first.wake();
	await first.stop();
	f.state.failModel = false;
	f.context.mode = "current-call-v1";
	f.advance();
	await f.create().wake();
	expect(f.context.reads).toBe(2);
	expect(f.context.checksBeforeRead).toEqual(
		original === undefined ? [1, 1] : [0, 0],
	);
	expect(f.state.results).toBe(1);
});
it("denies changed stored context mode before recovery reads", async () => {
	const f = await contextReadFixture("current-call-v1");
	f.state.failModel = true;
	const first = f.create();
	await first.wake();
	await first.stop();
	f.state.failModel = false;
	f.context.mode = undefined;
	f.advance();
	await f.create().wake();
	expect(f.context.reads).toBe(1);
	expect(f.state.results).toBe(0);
});
it("replays terminal receipts without context/model reopen under current-call mode", async () => {
	const f = await contextReadFixture("current-call-v1");
	f.state.loseResult = true;
	const first = f.create();
	await first.wake();
	await first.stop();
	const receipts = [...f.receipts];
	f.advance();
	await f.create().wake();
	expect(f.context.reads).toBe(1);
	expect(f.state.models).toBe(1);
	expect(f.state.results).toBe(2);
	expect([...f.receipts]).toEqual(receipts);
});
it("keeps model-selected context reads on independent preflight", async () => {
	const f = await contextReadFixture("current-call-v1");
	Object.assign(f.options.model, {
		async next() {
			f.state.models++;
			return f.state.models === 1
				? { type: "tool", call: { name: "read_context", arguments: {} } }
				: { type: "result", text: "Done" };
		},
	});
	await f.create().wake();
	expect(f.context.reads).toBe(2);
	expect(f.context.checksBeforeRead[0]).toBe(0);
	expect(f.context.checksBeforeRead[1]).toBeGreaterThan(0);
	expect(f.state.results).toBe(1);
});
it("denies expired local authority before a negotiated context call", async () => {
	const f = await contextReadFixture("current-call-v1");
	const now = Date.now();
	f.state.onGateway = (endpoint) => {
		if (endpoint === "progress")
			vi.spyOn(Date, "now").mockReturnValue(now + 70000);
	};
	await f.create().wake();
	expect(f.context.reads).toBe(0);
	expect(f.state.models).toBe(0);
});

it.each([
	false,
	true,
])("pins work-details negotiation across current renewal (initial=%s)", async (initial) => {
	const f = await contextReadFixture("current-call-v1");
	const original = f.options.gateway.call;
	let negotiated = initial;
	f.options.gateway.call = async (endpoint, body) => {
		const value = await original(endpoint, body);
		if (endpoint !== "authorize") return value;
		return {
			...value,
			nativeContext: {
				contractVersion: 1,
				bindingId: "g",
				scopeRef: "s",
				permissions: ["read", "work"],
				...(negotiated ? { workDetails: "waiting-v1" } : {}),
			},
		};
	};
	f.state.credentialTtl = 1000;
	f.state.onModel = async () => {
		negotiated = !initial;
	};
	await f.create().wake();
	expect(f.state.models).toBe(1);
	expect(f.state.results).toBe(0);
	expect(f.ledger.status("d").occurrences[0]?.status).not.toBe("completed");
});
