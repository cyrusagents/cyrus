import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { AutomationRuntime } from "../src/automations/AutomationRuntime.js";
import { AutomationCheckpointStore } from "../src/automations/CheckpointStore.js";
import {
	type AutomationRegistration,
	identity,
} from "../src/automations/contract.js";
import { AutomationDiagnosticError } from "../src/automations/Diagnostics.js";
import { AutomationLedger } from "../src/automations/Ledger.js";
import type { SessionDeliveryTransport } from "../src/sinks/SessionDeliveryTransport.js";
import { sessionDeliveryDigest } from "../src/sinks/session-delivery.js";

async function fixture(
	options: {
		negotiated?: boolean;
		cleanupFailure?: "model" | "tools";
		lostAck?: boolean;
		badAck?: "foreign" | "extra" | "denied" | "transport";
		terminal?: boolean;
		delivery?: Promise<void>;
	} = {},
) {
	const root = await mkdtemp(join(tmpdir(), "automation-interruption-"));
	let now = Date.now();
	const ledger = new AutomationLedger(root, "w", () => now);
	const store = new AutomationCheckpointStore(join(root, "checkpoints"));
	const definition: AutomationRegistration = {
		id: "d",
		workspaceId: "w",
		ownerId: "operator",
		namespace: "n",
		scopeRef: "s",
		revision: 1,
		state: "enabled",
		role: "coordinator",
		instruction: "Approved bounded task",
		schedule: null,
		target: { harness: "claude", model: "claude-fixture" },
	};
	ledger.upsert(definition);
	const occurrence = ledger.enqueue("d", 1, "event", "Immutable input");
	const events: string[] = [],
		keys: string[] = [],
		interrupts: Record<string, unknown>[] = [];
	let owner: Record<string, unknown> | undefined,
		interrupted = false,
		committed = false,
		resultCalls = 0,
		modelCalls = 0;
	let deliveryDone = !options.delivery;
	const runtime = new AutomationRuntime({
		workspaceId: () => "w",
		ledger,
		store,
		readiness: () => ({ ...definition.target, reason: null }),
		renewMilliseconds: 1000000,
		...(options.delivery && {
			sessions: {
				directory: join(root, "activities"),
				secrets: () => [],
				transport: {
					async deliver({
						item,
					}: Parameters<SessionDeliveryTransport["deliver"]>[0]) {
						if (item.sequence > 1 && !deliveryDone) {
							await options.delivery;
							deliveryDone = true;
							events.push("delivery-settled");
						}
						return {
							contractVersion: 1 as const,
							sessionId: item.sessionId,
							sequence: item.sequence,
							digest: sessionDeliveryDigest(item),
						};
					},
				},
			},
		}),
		model: {
			async next() {
				modelCalls++;
				if (options.terminal || committed)
					return { type: "result", text: "Complete" };
				return {
					type: "tool",
					call: {
						name: "add_comment",
						arguments: { text: "Exact approved payload" },
					},
				};
			},
			async close() {
				events.push("model-closed");
				if (options.cleanupFailure === "model") throw Error("cleanup");
			},
		},
		tools: () => ({
			async renew(op) {
				await op();
			},
			async close() {
				events.push("tools-closed");
				if (options.cleanupFailure === "tools") throw Error("cleanup");
			},
			async call(_call, key) {
				keys.push(key);
				if (!committed) {
					committed = true;
					throw Error("Uncertain write ACK");
				}
				return {
					items: [{ text: "Original write receipt" }],
					nextCursor: null,
				};
			},
		}),
		gateway: {
			async call(endpoint, body) {
				if (endpoint === "interrupt") {
					expect(deliveryDone).toBe(true);
					expect(events).toContain("model-closed");
					expect(events).toContain("tools-closed");
					expect(body).toEqual({ contractVersion: 1, ...owner });
					interrupts.push(structuredClone(body));
					events.push("interrupt");
					if (options.badAck === "foreign")
						return {
							contractVersion: 1,
							occurrenceId: "foreign",
							attemptId: body.attemptId,
							fence: body.fence,
							acknowledged: true,
						};
					if (options.badAck === "extra")
						return {
							contractVersion: 1,
							occurrenceId: body.occurrenceId,
							attemptId: body.attemptId,
							fence: body.fence,
							acknowledged: true,
							newAuthority: {},
						};
					if (options.badAck === "denied" || options.badAck === "transport")
						throw new AutomationDiagnosticError({
							phase: "interrupt",
							code:
								options.badAck === "denied"
									? "http_denied"
									: "transport_failed",
						});
					interrupted = true;
					if (options.lostAck && interrupts.length === 1)
						throw new AutomationDiagnosticError({
							phase: "interrupt",
							code: "transport_failed",
						});
					return {
						contractVersion: 1,
						occurrenceId: body.occurrenceId,
						attemptId: body.attemptId,
						fence: body.fence,
						acknowledged: true,
					};
				}
				if (endpoint === "authorize") {
					if (owner && owner.attemptId !== body.attemptId && !interrupted)
						throw new AutomationDiagnosticError({
							phase: "authorize",
							code: "http_denied",
							httpStatus: 409,
						});
					const authority = {
						contractVersion: 1 as const,
						definition: {
							...definition,
							grants: [
								{
									id: "grant",
									connectionId: "connection",
									accountId: "account",
									resource: {
										provider: "linear" as const,
										teamId: "team",
										issueId: "issue",
									},
									permissions: ["write" as const],
								},
							],
						},
						occurrenceId: occurrence.id,
						attemptId: String(body.attemptId),
						fence: Number(body.fence),
						input: occurrence.input,
						phase: "execute" as const,
						leaseUntil: new Date(Date.now() + 90000).toISOString(),
					};
					owner = { ...identity(authority), instanceId: body.instanceId };
					return {
						authority,
						...(options.negotiated !== false && { ownerInterruption: true }),
						mcp: {
							token: "fixture-credential-not-a-live-secret",
							audience: "/mcp",
							grantId: "grant",
							expiresAt: new Date(Date.now() + 60000).toISOString(),
						},
						...(options.delivery && {
							sessionDelivery: {
								contractVersion: 1,
								path: "/api/agent-sessions/v1/deliver",
								session: { id: "session", scopeRef: "s", role: "coordinator" },
							},
						}),
					};
				}
				if (endpoint === "progress") return {};
				resultCalls++;
				if (options.terminal)
					throw Error("Lost terminal result acknowledgement");
				return {
					contractVersion: 1,
					acknowledged: true,
					occurrenceId: body.occurrenceId,
					idempotencyKey: body.idempotencyKey,
				};
			},
		},
	});
	return {
		runtime,
		ledger,
		store,
		occurrence,
		definition,
		events,
		keys,
		interrupts,
		advance: () => {
			now += 5001;
		},
		get modelCalls() {
			return modelCalls;
		},
		get resultCalls() {
			return resultCalls;
		},
		async close() {
			await runtime.stop();
			ledger.close();
			await rm(root, { recursive: true, force: true });
		},
	};
}

it("releases only after cleanup, retries a lost ACK with the identical tuple, and resumes the uncertain write with its original key", async () => {
	const f = await fixture({ lostAck: true });
	try {
		await f.runtime.wake();
		const failed = f.ledger.status("d").occurrences[0]!;
		expect(failed.attempts).toBe(1);
		expect(failed.status).toBe("queued");
		expect(f.interrupts).toHaveLength(2);
		expect(f.interrupts[0]).toEqual(f.interrupts[1]);
		const checkpoint = await f.store.load(failed.checkpointScope!);
		expect(checkpoint!.status).toBe("running");
		expect(checkpoint!.sequence).toBe(0);
		expect(checkpoint!.pending!.key).toBe(f.keys[0]);
		f.advance();
		await f.runtime.wake();
		const completed = f.ledger.status("d").occurrences[0]!;
		expect(completed.status).toBe("completed");
		expect(completed.attempts).toBe(2);
		expect(completed.fence).toBe(2);
		expect(completed.input).toBe(f.occurrence.input);
		expect(completed.checkpointScope).toBe(failed.checkpointScope);
		expect(f.keys).toEqual([f.keys[0], f.keys[0]]);
		expect(f.interrupts).toHaveLength(2);
	} finally {
		await f.close();
	}
});

it.each([
	"model",
	"tools",
] as const)("does not release authority when %s cleanup fails", async (cleanupFailure) => {
	const f = await fixture({ cleanupFailure });
	try {
		await f.runtime.wake();
		expect(f.interrupts).toEqual([]);
		expect(f.events).toEqual(["model-closed", "tools-closed"]);
		f.advance();
		await f.runtime.wake();
		expect(f.ledger.status("d").occurrences[0]!.lastFailure!.httpStatus).toBe(
			409,
		);
	} finally {
		await f.close();
	}
});

it.each([
	"legacy",
	"terminal",
] as const)("never interrupts %s authority", async (kind) => {
	const f = await fixture(
		kind === "legacy" ? { negotiated: false } : { terminal: true },
	);
	try {
		await f.runtime.wake();
		expect(f.interrupts).toEqual([]);
		if (kind === "terminal") expect(f.resultCalls).toBe(1);
	} finally {
		await f.close();
	}
});

it("waits for outstanding activity delivery to settle before interrupting", async () => {
	let release!: () => void;
	const gate = new Promise<void>((r) => {
		release = r;
	});
	const f = await fixture({ delivery: gate });
	const work = f.runtime.wake();
	try {
		await expect.poll(() => f.events.includes("tools-closed")).toBe(true);
		expect(f.interrupts).toEqual([]);
		release();
		await work;
		expect(f.events.indexOf("delivery-settled")).toBeLessThan(
			f.events.indexOf("interrupt"),
		);
		expect(f.interrupts).toHaveLength(1);
	} finally {
		release();
		await work;
		await f.close();
	}
});

it.each([
	"foreign",
	"extra",
	"denied",
	"transport",
] as const)("bounds failed release (%s), preserves original failure and does not reset retry authority", async (badAck) => {
	const f = await fixture({ badAck });
	try {
		await f.runtime.wake();
		expect(f.interrupts).toHaveLength(badAck === "transport" ? 2 : 1);
		expect(f.ledger.status("d").occurrences[0]!.lastFailure!.phase).toBe(
			"execute",
		);
		f.advance();
		await f.runtime.wake();
		const current = f.ledger.status("d").occurrences[0]!;
		expect(current.attempts).toBe(2);
		expect(current.lastFailure!.httpStatus).toBe(409);
		expect(current.failureHistory![0].phase).toBe("execute");
	} finally {
		await f.close();
	}
});
