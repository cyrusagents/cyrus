import { describe, expect, it } from "vitest";
import {
	EdgeConfigSchema,
	MemoryGateConfigSchema,
} from "../src/config-schemas.js";

/**
 * Learning tests for the Zod schema attached to MemoryGateConfig.
 * The gate is a single-knob value: boolean | number in (0, 1].
 */
describe("MemoryGateConfigSchema", () => {
	it("accepts true (use default threshold)", () => {
		expect(MemoryGateConfigSchema.parse(true)).toBe(true);
	});

	it("accepts false (gate disabled)", () => {
		expect(MemoryGateConfigSchema.parse(false)).toBe(false);
	});

	it("accepts a number in (0, 1]", () => {
		expect(MemoryGateConfigSchema.parse(0.85)).toBe(0.85);
		expect(MemoryGateConfigSchema.parse(0.5)).toBe(0.5);
		expect(MemoryGateConfigSchema.parse(1)).toBe(1);
	});

	it("rejects 0 (must be greater than 0)", () => {
		expect(() => MemoryGateConfigSchema.parse(0)).toThrow();
	});

	it("rejects negative numbers", () => {
		expect(() => MemoryGateConfigSchema.parse(-0.1)).toThrow();
	});

	it("rejects numbers above 1", () => {
		expect(() => MemoryGateConfigSchema.parse(1.5)).toThrow();
	});

	it("rejects non-numeric, non-boolean values", () => {
		expect(() => MemoryGateConfigSchema.parse("0.85")).toThrow();
		expect(() => MemoryGateConfigSchema.parse({})).toThrow();
		expect(() => MemoryGateConfigSchema.parse(null)).toThrow();
	});
});

describe("EdgeConfigSchema — runner gate fields", () => {
	it("accepts maxConcurrentRunners as a non-negative integer", () => {
		const parsed = EdgeConfigSchema.parse({
			repositories: [],
			maxConcurrentRunners: 5,
		});
		expect(parsed.maxConcurrentRunners).toBe(5);
	});

	it("accepts maxConcurrentRunners=0 (cap disabled)", () => {
		const parsed = EdgeConfigSchema.parse({
			repositories: [],
			maxConcurrentRunners: 0,
		});
		expect(parsed.maxConcurrentRunners).toBe(0);
	});

	it("rejects negative maxConcurrentRunners", () => {
		expect(() =>
			EdgeConfigSchema.parse({
				repositories: [],
				maxConcurrentRunners: -1,
			}),
		).toThrow();
	});

	it("rejects non-integer maxConcurrentRunners", () => {
		expect(() =>
			EdgeConfigSchema.parse({
				repositories: [],
				maxConcurrentRunners: 2.5,
			}),
		).toThrow();
	});

	it("accepts memoryGate=true (single-knob form)", () => {
		const parsed = EdgeConfigSchema.parse({
			repositories: [],
			memoryGate: true,
		});
		expect(parsed.memoryGate).toBe(true);
	});

	it("accepts memoryGate=false (single-knob form)", () => {
		const parsed = EdgeConfigSchema.parse({
			repositories: [],
			memoryGate: false,
		});
		expect(parsed.memoryGate).toBe(false);
	});

	it("accepts memoryGate as a numeric threshold", () => {
		const parsed = EdgeConfigSchema.parse({
			repositories: [],
			memoryGate: 0.9,
		});
		expect(parsed.memoryGate).toBe(0.9);
	});

	it("rejects the legacy verbose object form", () => {
		expect(() =>
			EdgeConfigSchema.parse({
				repositories: [],
				memoryGate: { enabled: true, maxRssPercent: 0.75 },
			}),
		).toThrow();
	});

	it("accepts both memoryGate and maxConcurrentRunners together", () => {
		const parsed = EdgeConfigSchema.parse({
			repositories: [],
			memoryGate: 0.85,
			maxConcurrentRunners: 3,
		});
		expect(parsed.memoryGate).toBe(0.85);
		expect(parsed.maxConcurrentRunners).toBe(3);
	});
});
