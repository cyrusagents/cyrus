import { describe, expect, it } from "vitest";
import { readHostedTiming } from "../src/automations/HostedTiming.js";
import { LatencyTrace, measureLatency } from "../src/automations/Latency.js";

const response = (header: string, marker = "1", status = 200) =>
	new Response(null, {
		status,
		headers: { "server-timing": header, "x-cyrus-hosted-timing": marker },
	});
describe("optional Hosted diagnostic reader", () => {
	it("retains exactly the eight bounded numeric metrics and fixed flags", () => {
		const header =
			'cyrus_auth;dur=0, cyrus_body;dur=1.23, cyrus_event;dur=2.345, cyrus_admit;dur=600000;desc="capped", cyrus_commit;dur=3;desc="failed", cyrus_callback;dur=4, cyrus_interrupt;dur=5, cyrus_total;dur=600000.000;desc="capped"';
		expect(readHostedTiming(response(header))).toEqual({
			cyrus_auth: { durationMs: 0 },
			cyrus_body: { durationMs: 1.23 },
			cyrus_event: { durationMs: 2.345 },
			cyrus_admit: { durationMs: 600000, flag: "capped" },
			cyrus_commit: { durationMs: 3, flag: "failed" },
			cyrus_callback: { durationMs: 4 },
			cyrus_interrupt: { durationMs: 5 },
			cyrus_total: { durationMs: 600000, flag: "capped" },
		});
		expect(
			readHostedTiming(response('cyrus_commit;dur=3;desc="failed"', "1", 409)),
		).toEqual({ cyrus_commit: { durationMs: 3, flag: "failed" } });
	});
	it.each([
		"",
		"cyrus_total;dur=NaN",
		"cyrus_total;dur=Infinity",
		"cyrus_total;dur=-1",
		"cyrus_total;dur=600000.001",
		"cyrus_total;dur=1e3",
		"cyrus_total;dur=1.0001",
		'cyrus_total;dur=1;desc="private token"',
		'cyrus_total;dur=1;desc="capped"',
		"cyrus_total;dur=1;other=private",
		"cyrus_total;dur=1, cyrus_total;dur=2",
		"customer_secret;dur=2",
		"cyrus_total;dur=1, customer_secret;dur=2",
		"x".repeat(1025),
		`cyrus_auth;dur=0,${" ".repeat(1024)}cyrus_total;dur=1`,
	])("rejects malformed/unknown/oversized metadata %# without affecting response", (header) => {
		expect(readHostedTiming(response(header))).toBeUndefined();
	});
	it("requires the exact marker and rejects unauthenticated timings", () => {
		for (const marker of ["", "0", "2", "1, 1"])
			expect(
				readHostedTiming(response("cyrus_total;dur=1", marker)),
			).toBeUndefined();
		expect(
			readHostedTiming(response("cyrus_total;dur=1", "1", 401)),
		).toBeUndefined();
		expect(readHostedTiming(new Response(null))).toBeUndefined();
	});
	it("opts in only inside collected spans; copies only parsed metadata, leaving missing values unavailable", async () => {
		await measureLatency("result", async (timing) => {
			expect(timing).toBeUndefined();
		});
		const trace = new LatencyTrace();
		await trace.run(() =>
			measureLatency("model.next", async (timing) => {
				expect(timing).toBeUndefined();
			}),
		);
		await trace.run(() =>
			measureLatency("result", async (timing) => {
				expect(timing!.headers).toEqual({ "X-Cyrus-Latency-Diagnostics": "1" });
				timing!.read(response("cyrus_total;dur=2"));
			}),
		);
		await trace.run(() =>
			measureLatency("progress", async (timing) => {
				timing!.read(response("private;dur=3"));
			}),
		);
		const spans = trace
			.snapshot()
			.spans.filter((s) => s.stage !== "model.next");
		expect(spans[0]!.hosted).toEqual({ cyrus_total: { durationMs: 2 } });
		expect(spans[1]!.hosted).toBeUndefined();
		spans[0]!.hosted!.cyrus_total!.durationMs = 999;
		expect(
			trace.snapshot().spans.find((s) => s.stage === "result")!.hosted!
				.cyrus_total!.durationMs,
		).toBe(2);
		expect(JSON.stringify(trace.snapshot())).not.toContain("private");
		for (let i = 0; i < 128; i++) trace.mark("native.activity");
		await trace.run(() =>
			measureLatency("result", async (timing) => {
				expect(timing).toBeUndefined();
			}),
		);
		expect(trace.snapshot().spans).toHaveLength(128);
	});
});
