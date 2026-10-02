import { describe, expect, it } from "vitest";
import {
	AutomationLatency,
	type LatencyStage,
	LatencyTrace,
	markLatency,
	measureLatency,
} from "../src/automations/Latency.js";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
describe("bounded metadata-only latency diagnostics", () => {
	it("separates concurrent scopes and never retains payloads or raw errors", async () => {
		const first = new LatencyTrace(),
			second = new LatencyTrace();
		await Promise.all([
			first.run(() =>
				measureLatency("authorize.admit", async () => {
					await delay(20);
					markLatency("native.started");
					return { secret: "not telemetry" };
				}),
			),
			second.run(async () => {
				await expect(
					measureLatency("provider.body", async () => {
						await delay(5);
						throw new Error("private token");
					}),
				).rejects.toThrow("private token");
			}),
		]);
		expect(first.snapshot().spans.map((s) => s.stage)).toEqual([
			"authorize.admit",
			"native.started",
		]);
		expect(first.snapshot().spans[0]!.durationMs).toBeGreaterThanOrEqual(15);
		expect(second.snapshot().spans).toEqual([
			{
				stage: "provider.body",
				startMs: expect.any(Number),
				durationMs: expect.any(Number),
				failed: true,
			},
		]);
		expect(JSON.stringify([first.snapshot(), second.snapshot()])).not.toMatch(
			/private token|not telemetry/,
		);
		markLatency("model.request"); // Outside an admitted trace, no data is retained.
		expect(first.snapshot().spans).toHaveLength(2);
	});
	it("anchors monotonic stages to one numeric runtime epoch for correlation", async () => {
		const received = performance.now();
		const earliest = Date.now();
		await delay(5);
		const trace = new LatencyTrace(received);
		trace.begin("dispatch.received", received)(false, received);
		trace.mark("native.started");
		trace.finish();
		const snapshot = trace.snapshot();
		expect(snapshot.startedAtEpochMs).toBeGreaterThanOrEqual(earliest - 2);
		expect(snapshot.startedAtEpochMs).toBeLessThanOrEqual(earliest + 2);
		expect(snapshot.spans[0]!.startMs).toBe(0);
		expect(snapshot.spans[1]!.startMs).toBeGreaterThanOrEqual(4);
		expect(trace.snapshot().startedAtEpochMs).toBe(snapshot.startedAtEpochMs);
	});
	it("caps and flags spans, rejects non-enumerated labels, snapshots unfinished work", () => {
		const trace = new LatencyTrace();
		trace.mark("secret-customer-label" as LatencyStage);
		trace.begin("model.next");
		for (let n = 0; n < 200; n++) trace.mark("native.activity");
		const active = trace.snapshot();
		expect(active.finished).toBe(false);
		expect(active.spans[0]!.durationMs).toBeUndefined();
		expect(active.spans).toHaveLength(128);
		expect(active.droppedSpans).toBe(73);
		expect(JSON.stringify(active)).not.toContain("secret-customer");
		trace.finish();
		const elapsed = trace.snapshot().elapsedMs;
		expect(trace.snapshot().finished).toBe(true);
		expect(trace.snapshot().elapsedMs).toBe(elapsed);
	});
	it("bounds occurrence retention, preserves duplicate dispatch and replaces attempt without fabricating offline queue time", async () => {
		const records = new AutomationLatency();
		records.enqueued("one", performance.now());
		await delay(20);
		const trace = records.claimed("one", 1, performance.now());
		trace.mark("native.started");
		trace.finish();
		const saved = records.snapshot("one");
		records.enqueued("one", performance.now());
		expect(records.snapshot("one")).toEqual(saved);
		expect(
			saved!.spans.find((s) => s.stage === "queue.wait")!.durationMs,
		).toBeGreaterThanOrEqual(15);
		records.claimed("one", 2, performance.now()).finish();
		expect(records.snapshot("one")!.attempt).toBe(2);
		expect(records.snapshot("one")!.spans.map((s) => s.stage)).toEqual([
			"ledger.claim",
		]);
		for (let n = 0; n < 64; n++)
			records.claimed(`other-${n}`, 1, performance.now()).finish();
		expect(records.snapshot("one")).toBeUndefined();
		expect(new AutomationLatency().snapshot("other-63")).toBeUndefined();
	});
});
