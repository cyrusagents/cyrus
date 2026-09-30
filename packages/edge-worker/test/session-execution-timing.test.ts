import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSessionStatus } from "cyrus-core";
import { afterEach, expect, it, vi } from "vitest";
import { SessionActivityJournal } from "../src/sinks/SessionActivityJournal.js";
import { SessionExecutionTiming } from "../src/sinks/SessionExecutionTiming.js";
import {
	parseSessionDeliveryItem,
	sessionDeliveryDigest,
} from "../src/sinks/session-delivery.js";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	vi.useRealTimers();
	for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function fixture() {
	const directory = await mkdtemp(join(tmpdir(), "cyrus-execution-timing-"));
	cleanup.push(() => rm(directory, { recursive: true, force: true }));
	const open = (workspace = "workspace", scope = "scope") => {
		const journal = new SessionActivityJournal(directory, workspace, scope);
		cleanup.push(() => journal.close());
		return journal;
	};
	const journal = open();
	const item = journal.create({
		id: "session",
		scopeRef: "scope",
		role: "coordinator",
	});
	journal.acknowledge(item, {
		contractVersion: 1,
		sessionId: item.sessionId,
		sequence: 1,
		digest: sessionDeliveryDigest(item),
	});
	let now = 1000;
	let wall = "2026-09-30T06:00:00.000Z";
	const controller = new AbortController();
	const clock = { monotonic: () => now, wall: () => wall };
	const timing = (
		fence = 1,
		historical = false,
		db = journal,
		signal = controller.signal,
	) =>
		new SessionExecutionTiming(
			db,
			"session",
			`attempt-${fence}`,
			fence,
			historical,
			signal,
			() => controller.abort(),
			clock,
		);
	return {
		journal,
		open,
		timing,
		controller,
		advance: (ms: number) => {
			now += ms;
		},
		wall: (value: string) => {
			wall = value;
		},
	};
}

it("sums only measured execution and ignores queue, wall-clock jumps, delivery and resume gaps", async () => {
	const f = await fixture();
	const timing = f.timing();
	f.advance(3600000); // queued/admission time, outside an operation
	await timing.measure("model", async () => {
		f.advance(45000);
		f.wall("2020-01-01T00:00:00.000Z");
	});
	f.advance(900000); // transport/receipt wait
	await timing.measure("tool", async () => {
		await timing.exclude(async () => f.advance(60000));
		f.advance(120);
	});
	expect(timing.snapshot()).toEqual({
		executionDurationMs: 45120,
		executionDurationComplete: true,
	});
	f.advance(9999999);
	const next = f.timing(2, true, f.open()); // reconnect to a second SQLite connection
	expect(next.snapshot()).toEqual({
		executionDurationMs: 45120,
		executionDurationComplete: true,
	});
	expect(() => timing.snapshot()).toThrow("Stale execution timing owner");
});

it("closes on revocation and counts retried work once while fencing the previous timing writer", async () => {
	const f = await fixture();
	const timing = f.timing();
	await timing.measure("tool", async () => {
		f.advance(75);
		f.controller.abort();
		f.advance(100000);
	});
	expect(timing.snapshot()).toEqual({
		executionDurationMs: 75,
		executionDurationComplete: true,
	});
	const next = f.timing(2, true, f.open(), new AbortController().signal);
	await next.measure("model", async () => {
		f.advance(25);
	});
	expect(next.snapshot()).toEqual({
		executionDurationMs: 100,
		executionDurationComplete: true,
	});
	expect(() => timing.snapshot()).toThrow("Stale execution timing owner");
	expect(() => f.timing(2)).toThrow("Stale execution timing owner");
});

it("recovers an abruptly abandoned interval only through its last durable heartbeat sample", async () => {
	vi.useFakeTimers();
	const f = await fixture();
	const timing = f.timing();
	void timing.measure("model", () => new Promise(() => {}));
	f.advance(5000);
	await vi.advanceTimersByTimeAsync(5000);
	expect(f.journal.execution("session")!.intervals[0]).toMatchObject({
		durationMs: 5000,
		closed: false,
	});
	vi.clearAllTimers(); // process death: no finally/abort handler runs
	f.advance(86400000);
	const next = f.timing(2, true, f.open());
	expect(next.snapshot()).toEqual({
		executionDurationMs: 5000,
		executionDurationComplete: false,
	});
	await next.measure("tool", async () => f.advance(50));
	expect(next.snapshot()).toEqual({
		executionDurationMs: 5050,
		executionDurationComplete: false,
	});
	expect(f.journal.execution("session")!.intervals.every((i) => i.closed)).toBe(
		true,
	);
});

it("marks pre-upgrade work incomplete and denies cross-workspace/customer timing lookup", async () => {
	const f = await fixture();
	const timing = f.timing(1, true);
	await timing.measure("model", async () => f.advance(100));
	expect(timing.snapshot()).toEqual({
		executionDurationMs: 100,
		executionDurationComplete: false,
	});
	expect(() => f.open("another-workspace").execution("session")).toThrow(
		"no admitted creation",
	);
	expect(() =>
		f.open("workspace", "another-customer").execution("session"),
	).toThrow("no admitted creation");
});

it("persists immutable cumulative lifecycle measurements across lost ACK and later retry", async () => {
	const f = await fixture();
	const timing = f.timing();
	await timing.measure("model", async () => f.advance(45000));
	const payload = { status: AgentSessionStatus.Complete, ...timing.snapshot() };
	const first = f.journal.append(
		"session",
		{ kind: "lifecycle", payload },
		"result:complete",
	);
	const resumed = f.timing(2, true, f.open());
	f.advance(86400000); // result-only reconciliation must not count this gap
	const replay = f.journal.append(
		"session",
		{
			kind: "lifecycle",
			payload: { status: AgentSessionStatus.Complete, ...resumed.snapshot() },
		},
		"result:complete",
	);
	expect(replay).toEqual(first);
	expect(sessionDeliveryDigest(replay)).toBe(sessionDeliveryDigest(first));
});

it("requires a bounded duration/completeness pair and preserves old lifecycle payloads", () => {
	const base = {
		sessionId: "session",
		sequence: 2,
		kind: "lifecycle",
		payload: { status: "complete" },
	};
	expect(parseSessionDeliveryItem(base)).toEqual(base);
	for (const measurement of [
		{ executionDurationMs: 1 },
		{ executionDurationComplete: true },
		{ executionDurationMs: -1, executionDurationComplete: true },
		{ executionDurationMs: 1.5, executionDurationComplete: true },
		{
			executionDurationMs: Number.MAX_SAFE_INTEGER + 1,
			executionDurationComplete: true,
		},
		{ executionDurationMs: 1, executionDurationComplete: "yes" },
	])
		expect(() =>
			parseSessionDeliveryItem({
				...base,
				payload: { ...base.payload, ...measurement },
			}),
		).toThrow();
});

it("counts provider/broker and tool waits but excludes blocking authority and between-step delivery", async () => {
	const f = await fixture();
	const timing = f.timing();
	f.advance(520); // admission and durable session creation before native invocation
	await timing.measure("model", async () => {
		await timing.exclude(async () => {
			f.advance(500);
		}); // native broker authorization
		await Promise.resolve();
		f.advance(200); // actual provider response wait is measured
	});
	f.advance(800); // native tool reply is withheld by supervisor receipt delivery
	await timing.measure("tool", async () => {
		await Promise.resolve();
		f.advance(30);
	});
	expect(timing.snapshot()).toEqual({
		executionDurationMs: 230,
		executionDurationComplete: true,
	});
	// Native task wall time would include 500+200+800+30=1530ms, not just230ms.
	// A measured counter is not CPU time, native turn wall time, or submission latency.
	f.advance(1000); // terminal receipt ACK is not execution
	expect(timing.snapshot().executionDurationMs).toBe(230);
});
