import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { AutomationRuntime } from "../src/automations/AutomationRuntime.js";
import { AutomationCheckpointStore } from "../src/automations/CheckpointStore.js";
import type { AutomationRegistration } from "../src/automations/contract.js";
import { AutomationLedger } from "../src/automations/Ledger.js";
import { recoveryRequestSchema } from "../src/automations/Recovery.js";

const definition: AutomationRegistration = {
	id: "automation",
	workspaceId: "workspace",
	ownerId: "operator",
	namespace: "scope",
	scopeRef: "binding",
	revision: 1,
	state: "enabled",
	role: "coordinator",
	instruction: "Review",
	schedule: null,
	target: { harness: "claude", model: "claude-fixture" },
};
async function fixture() {
	const directory = await mkdtemp(join(tmpdir(), "automation-recovery-"));
	let now = Date.now();
	const db = new AutomationLedger(directory, "workspace", () => now);
	db.upsert(definition);
	const original = db.enqueue(
		definition.id,
		1,
		"event",
		"Original private input",
	);
	const request = () => ({
		contractVersion: 1 as const,
		workspaceId: "workspace",
		automationId: definition.id,
		revision: 1,
		occurrenceId: original.id,
		commandId: randomUUID(),
		expectedFence: db.status(definition.id).occurrences[0]!.fence,
	});
	const exhaust = () => {
		for (let n = 0; n < 3; n++) {
			const claim = db.claim(1)[0]!;
			db.finish(claim.occurrence, false);
			now += 11000;
		}
	};
	return {
		directory,
		db,
		original,
		request,
		exhaust,
		advance: (ms: number) => {
			now += ms;
		},
		clock: () => now,
		close: async () => {
			db.close();
			await rm(directory, { recursive: true, force: true });
		},
	};
}
it("deduplicates recovery atomically across connections/restart, preserves identity, bounds each cycle, and never reuses fences", async () => {
	const f = await fixture();
	let other: AutomationLedger | undefined;
	try {
		f.exhaust();
		const blocked = f.db.status(definition.id).occurrences[0]!;
		const command = f.request();
		const receipt = f.db.recover(command);
		other = new AutomationLedger(f.directory, "workspace", f.clock);
		expect(other.recover(command)).toEqual(receipt);
		expect(f.db.status(definition.id).occurrences[0]).toMatchObject({
			id: f.original.id,
			input: f.original.input,
			scheduledAt: f.original.scheduledAt,
			order: f.original.order,
			attempts: 3,
			fence: 3,
			status: "queued",
			retryCycle: { number: 1, attemptsBase: 3 },
		});
		const first = f.db.claim(1)[0]!.occurrence;
		expect(first).toMatchObject({ attempts: 4, fence: 4 });
		expect(first.attemptId).not.toBe(blocked.attemptId);
		expect(other.recover(command)).toEqual(receipt);
		expect(() =>
			other!.recover({ ...command, commandId: randomUUID(), expectedFence: 4 }),
		).toThrow();
		other.finish(blocked, true);
		expect(f.db.status(definition.id).occurrences[0]!.status).toBe("running");
		f.db.finish(first, false);
		f.advance(6000);
		for (let i = 0; i < 2; i++) {
			const c = f.db.claim(1)[0]!.occurrence;
			f.db.finish(c, false);
			f.advance(11000);
		}
		expect(f.db.status(definition.id).occurrences[0]).toMatchObject({
			status: "blocked",
			attempts: 6,
			fence: 6,
		});
		expect(f.db.recover(command)).toEqual(receipt);
		expect(f.db.claim(1)).toEqual([]);
		expect(() => f.db.recover({ ...command, expectedFence: 6 })).toThrow(
			"conflict",
		);
		other.close();
		other = new AutomationLedger(f.directory, "workspace", f.clock);
		expect(other.recover(command)).toEqual(receipt);
		const next = { ...command, commandId: randomUUID(), expectedFence: 6 };
		expect(other.recover(next).cycle).toBe(2);
		const c = f.db.claim(1)[0]!.occurrence;
		expect(c).toMatchObject({ attempts: 7, fence: 7 });
		f.db.finish(c, true);
		expect(other.recover(next).cycle).toBe(2);
		expect(() =>
			f.db.recover({ ...next, commandId: randomUUID(), expectedFence: 7 }),
		).toThrow();
	} finally {
		other?.close();
		await f.close();
	}
});
it("rejects scope/revision/fence widening and active, completed, paused or deleted recovery", async () => {
	const f = await fixture();
	try {
		expect(() => f.db.recover({ ...f.request(), expectedFence: 1 })).toThrow();
		f.exhaust();
		const command = f.request();
		for (const patch of [
			{ workspaceId: "foreign" },
			{ automationId: "foreign" },
			{ revision: 2 },
			{ occurrenceId: "a".repeat(64) },
			{ expectedFence: 2 },
		])
			expect(() => f.db.recover({ ...command, ...patch })).toThrow();
		for (const field of [
			"input",
			"namespace",
			"scopeRef",
			"grants",
			"attempts",
			"reset",
			"model",
		])
			expect(
				recoveryRequestSchema.safeParse({ ...command, [field]: "widen" })
					.success,
			).toBe(false);
		f.db.upsert({ ...definition, revision: 2, state: "paused" });
		expect(() => f.db.recover(command)).toThrow();
		f.db.upsert({ ...definition, revision: 3 });
		expect(() => f.db.recover(command)).toThrow();
		f.db.upsert({ ...definition, revision: 4, state: "deleted" });
		expect(() => f.db.recover({ ...command, revision: 4 })).toThrow();
	} finally {
		await f.close();
	}
});
it("expired recovered owners consume the same bounded cycle; recovered ticks are not coalesced away", async () => {
	const f = await fixture();
	try {
		f.exhaust();
		f.db.recover(f.request());
		for (let n = 0; n < 3; n++) {
			expect(f.db.claim(1)).toHaveLength(1);
			f.advance(90001);
		}
		expect(f.db.claim(1)).toEqual([]);
		expect(f.db.status(definition.id).occurrences[0]).toMatchObject({
			status: "blocked",
			attempts: 6,
			fence: 6,
		});
		const tick = {
			...definition,
			id: "tick",
			namespace: "tick",
			schedule: {
				intervalSeconds: 60,
				anchorAt: new Date(f.clock()).toISOString(),
				timezone: "UTC",
			},
		};
		f.db.upsert(tick);
		for (let n = 0; n < 3; n++) {
			const c = f.db.claim(1)[0]!.occurrence;
			f.db.finish(c, false);
			f.advance(11000);
		}
		const blocked = f.db.status("tick").occurrences[0]!;
		f.db.recover({
			...f.request(),
			automationId: "tick",
			occurrenceId: blocked.id,
			expectedFence: blocked.fence,
		});
		f.advance(60000);
		expect(f.db.claim(1)[0]!.occurrence.id).toBe(blocked.id);
	} finally {
		await f.close();
	}
});
it("rechecks current Hosted authority and reconciles the original pending write after operator recovery", async () => {
	const f = await fixture();
	let revoked = false,
		changedScope = false,
		acceptWrite = false,
		models = 0,
		effects = 0;
	const keys: string[] = [];
	const seen = new Set<string>();
	const runtime = new AutomationRuntime({
		workspaceId: () => "workspace",
		ledger: f.db,
		store: new AutomationCheckpointStore(join(f.directory, "checkpoints")),
		readiness: () => ({ ...definition.target, reason: null }),
		model: {
			async next() {
				models++;
				return models === 1
					? {
							type: "tool" as const,
							call: {
								name: "add_comment" as const,
								arguments: { text: "Approved original payload" },
							},
						}
					: { type: "result" as const, text: "Done" };
			},
		},
		tools: () => ({
			async call(call, key) {
				keys.push(key);
				expect(call).toEqual({
					name: "add_comment",
					arguments: { text: "Approved original payload" },
				});
				if (!seen.has(key)) {
					seen.add(key);
					effects++;
				}
				if (!acceptWrite) throw Error("Lost acknowledgement");
				return { items: [{ text: "Published" }], nextCursor: null };
			},
			async close() {},
			async renew(op) {
				await op();
			},
		}),
		gateway: {
			async call(endpoint, body) {
				if (endpoint === "authorize") {
					if (revoked) throw Error("Current authority revoked");
					return {
						authority: {
							contractVersion: 1,
							definition: {
								...definition,
								grants: [
									{
										id: "grant",
										connectionId: "connection",
										accountId: "account",
										resource: {
											provider: "linear",
											teamId: "team",
											issueId: changedScope ? "foreign-issue" : "issue",
										},
										permissions: ["read", "write"],
									},
								],
							},
							occurrenceId: body.occurrenceId,
							attemptId: body.attemptId,
							fence: body.fence,
							leaseUntil: new Date(Date.now() + 90000).toISOString(),
							phase: "execute",
							input: f.original.input,
						},
						mcp: {
							token: "fixture-credential-not-a-live-secret",
							audience: "/mcp",
							grantId: "grant",
							expiresAt: new Date(Date.now() + 60000).toISOString(),
						},
					};
				}
				if (endpoint === "result")
					return {
						contractVersion: 1,
						acknowledged: true,
						occurrenceId: body.occurrenceId,
						idempotencyKey: body.idempotencyKey,
					};
				return {};
			},
		},
	});
	try {
		for (let i = 0; i < 3; i++) {
			await runtime.wake();
			f.advance(11000);
		}
		expect(f.db.status(definition.id).occurrences[0]!.status).toBe("blocked");
		expect(models).toBe(1);
		expect(effects).toBe(1);
		expect(keys).toHaveLength(3);
		revoked = true;
		runtime.recover(f.request());
		for (let i = 0; i < 3; i++) {
			await runtime.wake();
			f.advance(11000);
		}
		expect(f.db.status(definition.id).occurrences[0]).toMatchObject({
			status: "blocked",
			attempts: 6,
			fence: 6,
		});
		expect(models).toBe(1);
		expect(keys).toHaveLength(3);
		revoked = false;
		changedScope = true;
		runtime.recover(f.request());
		for (let i = 0; i < 3; i++) {
			await runtime.wake();
			f.advance(11000);
		}
		expect(f.db.status(definition.id).occurrences[0]).toMatchObject({
			status: "blocked",
			attempts: 9,
			fence: 9,
		});
		expect(models).toBe(1);
		expect(keys).toHaveLength(3);
		changedScope = false;
		acceptWrite = true;
		runtime.recover(f.request());
		await runtime.wake();
		expect(f.db.status(definition.id).occurrences[0]).toMatchObject({
			status: "completed",
			attempts: 10,
			fence: 10,
		});
		expect(models).toBe(2);
		expect(effects).toBe(1);
		expect(keys).toHaveLength(4);
		expect(new Set(keys).size).toBe(1);
	} finally {
		await runtime.stop();
		await f.close();
	}
});

it("operator recovery of a terminal receipt never reopens the model or tools", async () => {
	const f = await fixture();
	let committed = false,
		ack = false,
		models = 0;
	const keys: string[] = [];
	const runtime = new AutomationRuntime({
		workspaceId: () => "workspace",
		ledger: f.db,
		store: new AutomationCheckpointStore(join(f.directory, "checkpoints")),
		readiness: () => ({
			...definition.target,
			reason: committed ? "Model unavailable" : null,
		}),
		model: {
			async next() {
				models++;
				return { type: "result" as const, text: "Immutable completed result" };
			},
		},
		tools: () => ({
			async call() {
				throw Error("Terminal recovery must not call tools");
			},
			async close() {},
			async renew(op) {
				await op();
			},
		}),
		gateway: {
			async call(endpoint, body) {
				if (endpoint === "authorize")
					return {
						authority: {
							contractVersion: 1,
							definition: { ...definition, grants: [] },
							occurrenceId: body.occurrenceId,
							attemptId: body.attemptId,
							fence: body.fence,
							leaseUntil: new Date(Date.now() + 90000).toISOString(),
							phase: committed ? "reconcile" : "execute",
							input: f.original.input,
						},
						mcp: {
							token: "fixture-credential-not-a-live-secret",
							audience: "/mcp",
							grantId: "grant",
							expiresAt: new Date(Date.now() + 60000).toISOString(),
						},
					};
				if (endpoint === "result") {
					keys.push(String(body.idempotencyKey));
					committed = true;
					if (!ack) throw Error("Lost result acknowledgement");
					return {
						contractVersion: 1,
						acknowledged: true,
						occurrenceId: body.occurrenceId,
						idempotencyKey: body.idempotencyKey,
					};
				}
				return {};
			},
		},
	});
	try {
		for (let i = 0; i < 3; i++) {
			await runtime.wake();
			f.advance(11000);
		}
		const blocked = f.db.status(definition.id).occurrences[0]!;
		expect(blocked).toMatchObject({
			status: "blocked",
			receipt: { attempts: 3 },
		});
		expect(models).toBe(1);
		expect(runtime.capabilities().available).toBe(false);
		runtime.recover(f.request());
		ack = true;
		await runtime.wake();
		expect(f.db.status(definition.id).occurrences[0]).toMatchObject({
			status: "completed",
			attempts: 4,
			fence: 4,
			receipt: { attempts: 4, scopeKey: blocked.receipt!.scopeKey },
		});
		expect(models).toBe(1);
		expect(keys).toHaveLength(4);
		expect(new Set(keys).size).toBe(1);
	} finally {
		await runtime.stop();
		await f.close();
	}
});

it("explicit cycles count terminal transitions within the same three-claim budget and retain checkpoint scope", async () => {
	const f = await fixture();
	try {
		f.exhaust();
		f.db.recover(f.request());
		for (let i = 0; i < 2; i++) {
			const c = f.db.claim(1)[0]!.occurrence;
			f.db.bindCheckpoint(c, "b".repeat(64));
			f.db.finish(c, false);
			f.advance(11000);
		}
		const last = f.db.claim(1)[0]!.occurrence;
		expect(() => f.db.bindCheckpoint(last, "c".repeat(64))).toThrow(
			"scope changed",
		);
		f.db.markReceipt(last, definition, "b".repeat(64));
		f.db.finish(last, false);
		f.advance(11000);
		expect(f.db.claim(1)).toEqual([]);
		expect(f.db.status(definition.id).occurrences[0]).toMatchObject({
			status: "blocked",
			attempts: 6,
			fence: 6,
			checkpointScope: "b".repeat(64),
			receipt: { attempts: 1, scopeKey: "b".repeat(64) },
		});
	} finally {
		await f.close();
	}
});
