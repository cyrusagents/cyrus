import { describe, expect, it } from "vitest";
import {
	checkMemoryHealth,
	collectMemoryMetrics,
	DEFAULT_MEMORY_PRESSURE_THRESHOLD,
	formatMemoryPressureMessage,
	type MemorySources,
} from "../src/memory-health.js";

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;

function sourcesFor(args: {
	rss: number;
	total: number;
	free: number;
	heapUsed: number;
	heapLimit: number;
}): MemorySources {
	return {
		rssBytes: () => args.rss,
		totalSystemBytes: () => args.total,
		availableSystemBytes: () => args.free,
		heapUsedBytes: () => args.heapUsed,
		heapLimitBytes: () => args.heapLimit,
	};
}

/** Healthy host: low RSS, lots of free memory, low heap. */
const calmSources = sourcesFor({
	rss: 0.5 * GB,
	total: 4 * GB,
	free: 3 * GB,
	heapUsed: 200 * MB,
	heapLimit: 2 * GB,
});

describe("checkMemoryHealth — single-knob config", () => {
	it("reports ok when gate is omitted (undefined)", () => {
		const result = checkMemoryHealth(undefined, calmSources);
		expect(result.ok).toBe(true);
	});

	it("reports ok when gate is false", () => {
		// Even a host that's about to OOM should pass when the gate is off.
		const dire = sourcesFor({
			rss: 4 * GB,
			total: 4 * GB,
			free: 0,
			heapUsed: 4 * GB,
			heapLimit: 4 * GB,
		});
		expect(checkMemoryHealth(false, dire).ok).toBe(true);
	});

	it("uses the default threshold (0.85) when gate is true", () => {
		// 80% pressure → under default 85% → allowed
		const ok = sourcesFor({
			rss: 0.8 * 4 * GB,
			total: 4 * GB,
			free: 0.2 * 4 * GB,
			heapUsed: 100 * MB,
			heapLimit: 2 * GB,
		});
		expect(checkMemoryHealth(true, ok).ok).toBe(true);

		// 90% pressure → over default 85% → rejected
		const tight = sourcesFor({
			rss: 0.9 * 4 * GB,
			total: 4 * GB,
			free: 0.1 * 4 * GB,
			heapUsed: 100 * MB,
			heapLimit: 2 * GB,
		});
		expect(checkMemoryHealth(true, tight).ok).toBe(false);
	});

	it("DEFAULT_MEMORY_PRESSURE_THRESHOLD matches the documented default", () => {
		expect(DEFAULT_MEMORY_PRESSURE_THRESHOLD).toBe(0.85);
	});

	it("accepts a numeric threshold and rejects above it", () => {
		const sources = sourcesFor({
			rss: 0.8 * 4 * GB,
			total: 4 * GB,
			free: 0.2 * 4 * GB,
			heapUsed: 100 * MB,
			heapLimit: 2 * GB,
		});
		expect(checkMemoryHealth(0.7, sources).ok).toBe(false);
		expect(checkMemoryHealth(0.9, sources).ok).toBe(true);
	});

	it("uses strict greater-than (boundary value passes)", () => {
		// pressure exactly 0.75 — equals threshold — should NOT reject
		const sources = sourcesFor({
			rss: 3 * GB,
			total: 4 * GB,
			free: 1 * GB,
			heapUsed: 100 * MB,
			heapLimit: 2 * GB,
		});
		expect(checkMemoryHealth(0.75, sources).ok).toBe(true);
	});

	it("rejection reason names the dominant dimension (RSS)", () => {
		const sources = sourcesFor({
			rss: 0.95 * 4 * GB,
			total: 4 * GB,
			free: 0.4 * 4 * GB, // system used = 60%
			heapUsed: 100 * MB, // heap = 5%
			heapLimit: 2 * GB,
		});
		const result = checkMemoryHealth(0.5, sources);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toMatch(/RSS/i);
	});

	it("rejection reason names the dominant dimension (heap)", () => {
		const sources = sourcesFor({
			rss: 0.1 * 4 * GB, // RSS = 10%
			total: 4 * GB,
			free: 3.9 * GB, // system used = 2.5%
			heapUsed: 1.9 * GB,
			heapLimit: 2 * GB, // heap = 95%
		});
		const result = checkMemoryHealth(0.5, sources);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toMatch(/heap/i);
	});

	it("rejection reason names the dominant dimension (system memory)", () => {
		// RSS is small, heap is small, but the host as a whole is full
		// (e.g. another process is hogging memory).
		const sources = sourcesFor({
			rss: 0.1 * 4 * GB,
			total: 4 * GB,
			free: 0.05 * 4 * GB, // system used = 95%
			heapUsed: 100 * MB,
			heapLimit: 2 * GB,
		});
		const result = checkMemoryHealth(0.5, sources);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toMatch(/system memory/i);
	});

	it("rejection result carries the metrics snapshot", () => {
		const sources = sourcesFor({
			rss: 3.5 * GB,
			total: 4 * GB,
			free: 0.5 * GB,
			heapUsed: 200 * MB,
			heapLimit: 2 * GB,
		});
		const result = checkMemoryHealth(0.5, sources);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.metrics.rssMb).toBeCloseTo(3584, 0);
			expect(result.metrics.totalSystemMemoryMb).toBeCloseTo(4096, 0);
			expect(result.metrics.availableSystemMemoryMb).toBeCloseTo(512, 0);
			expect(result.metrics.pressure).toBeGreaterThan(0.5);
		}
	});
});

describe("collectMemoryMetrics", () => {
	it("returns zero percent when totals are zero (defensive)", () => {
		const metrics = collectMemoryMetrics(
			sourcesFor({
				rss: 1024,
				total: 0,
				free: 0,
				heapUsed: 0,
				heapLimit: 0,
			}),
		);
		expect(metrics.rssPercent).toBe(0);
		expect(metrics.heapPercent).toBe(0);
		expect(metrics.systemUsedPercent).toBe(0);
		expect(metrics.pressure).toBe(0);
	});

	it("computes pressure as max(rss, heap, systemUsed)", () => {
		const metrics = collectMemoryMetrics(
			sourcesFor({
				rss: 0.4 * 4 * GB,
				total: 4 * GB,
				free: 0.5 * 4 * GB, // system used = 50%
				heapUsed: 0.7 * 2 * GB, // heap = 70%
				heapLimit: 2 * GB,
			}),
		);
		expect(metrics.rssPercent).toBeCloseTo(0.4, 5);
		expect(metrics.heapPercent).toBeCloseTo(0.7, 5);
		expect(metrics.systemUsedPercent).toBeCloseTo(0.5, 5);
		expect(metrics.pressure).toBeCloseTo(0.7, 5);
	});
});

describe("formatMemoryPressureMessage", () => {
	it("produces a user-facing message without leaking the technical reason", () => {
		const msg = formatMemoryPressureMessage();
		expect(msg).toContain("Cyrus is temporarily out of capacity");
		expect(msg).not.toMatch(/rss|heap|memory|%/i);
	});
});
