import { describe, expect, it } from "vitest";
import {
	EFFORT_DIRECTIVE_VALUES,
	resolveLiveEffort,
	resolveStartEffort,
} from "../src/effort.js";

describe("resolveStartEffort", () => {
	it("maps plain levels 1:1 with no ultracode", () => {
		for (const level of ["low", "medium", "high", "xhigh", "max"] as const) {
			expect(resolveStartEffort(level)).toEqual({ effort: level });
		}
	});

	it("maps ultra to xhigh + ultracode", () => {
		expect(resolveStartEffort("ultra")).toEqual({
			effort: "xhigh",
			ultracode: true,
		});
	});
});

describe("resolveLiveEffort", () => {
	it("maps plain flag levels and clears ultracode + workflows", () => {
		for (const level of ["low", "medium", "high", "xhigh"] as const) {
			expect(resolveLiveEffort(level)).toEqual({
				flagSettings: {
					effortLevel: level,
					ultracode: false,
					enableWorkflows: false,
				},
				clampedFromMax: false,
				label: level,
			});
		}
	});

	it("clamps max to xhigh and flags it", () => {
		const result = resolveLiveEffort("max");
		expect(result.flagSettings).toEqual({
			effortLevel: "xhigh",
			ultracode: false,
			enableWorkflows: false,
		});
		expect(result.clampedFromMax).toBe(true);
		expect(result.label).toContain("clamped from max");
	});

	it("maps ultra to xhigh + ultracode + workflows enabled", () => {
		const result = resolveLiveEffort("ultra");
		expect(result.flagSettings).toEqual({
			effortLevel: "xhigh",
			ultracode: true,
			enableWorkflows: true,
		});
		expect(result.clampedFromMax).toBe(false);
		expect(result.label).toContain("ultracode");
	});
});

describe("EFFORT_DIRECTIVE_VALUES", () => {
	it("lists every recognized directive token", () => {
		expect([...EFFORT_DIRECTIVE_VALUES]).toEqual([
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
			"ultra",
		]);
	});
});
