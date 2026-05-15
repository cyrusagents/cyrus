/**
 * Tests for the B2 per-project reply rate limiter.
 */

import { describe, expect, it } from "vitest";
import { ProjectReplyRateLimiter } from "../src/ProjectReplyRateLimiter.js";

function makeLimiter(count: number, windowMs: number, nowRef: { now: number }) {
	return new ProjectReplyRateLimiter(
		() => ({ count, windowMs }),
		() => nowRef.now,
	);
}

describe("ProjectReplyRateLimiter (B2)", () => {
	it("allows replies up to the configured count, then blocks", () => {
		const now = { now: 1_000 };
		const limiter = makeLimiter(3, 60_000, now);

		expect(limiter.isLimited("p1")).toBe(false);
		limiter.record("p1");
		expect(limiter.isLimited("p1")).toBe(false);
		limiter.record("p1");
		expect(limiter.isLimited("p1")).toBe(false);
		limiter.record("p1");
		// 3 records now within the window — fourth would exceed.
		expect(limiter.isLimited("p1")).toBe(true);
	});

	it("prunes records older than the rolling window", () => {
		const now = { now: 1_000 };
		const limiter = makeLimiter(3, 60_000, now);

		limiter.record("p1");
		limiter.record("p1");
		limiter.record("p1");
		expect(limiter.isLimited("p1")).toBe(true);

		// Advance past the window — old records should drop off.
		now.now += 60_001;
		expect(limiter.isLimited("p1")).toBe(false);
		expect(limiter.count("p1")).toBe(0);
	});

	it("tracks projects independently", () => {
		const now = { now: 1_000 };
		const limiter = makeLimiter(2, 60_000, now);

		limiter.record("p1");
		limiter.record("p1");
		expect(limiter.isLimited("p1")).toBe(true);
		expect(limiter.isLimited("p2")).toBe(false);
		limiter.record("p2");
		expect(limiter.isLimited("p2")).toBe(false);
		limiter.record("p2");
		expect(limiter.isLimited("p2")).toBe(true);
	});

	it("a partial-window prune keeps only the recent entries", () => {
		const now = { now: 1_000 };
		const limiter = makeLimiter(5, 1_000, now);

		limiter.record("p1");
		now.now += 500;
		limiter.record("p1");
		now.now += 600; // first record now older than the 1000ms window
		expect(limiter.count("p1")).toBe(1);
	});
});
