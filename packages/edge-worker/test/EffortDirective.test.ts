import { describe, expect, it } from "vitest";
import { parseEffortDirective } from "../src/EffortDirective.js";

describe("parseEffortDirective", () => {
	it("returns null for empty/missing input", () => {
		expect(parseEffortDirective(undefined)).toBeNull();
		expect(parseEffortDirective(null)).toBeNull();
		expect(parseEffortDirective("")).toBeNull();
	});

	it("parses each recognized level on its own line", () => {
		for (const level of [
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
			"ultra",
		] as const) {
			expect(parseEffortDirective(`Effort: ${level}`)).toBe(level);
		}
	});

	it("is case-insensitive for keyword and value", () => {
		expect(parseEffortDirective("EFFORT: HIGH")).toBe("high");
		expect(parseEffortDirective("effort: Max")).toBe("max");
	});

	it("tolerates surrounding whitespace and tabs", () => {
		expect(parseEffortDirective("  effort  :  xhigh  ")).toBe("xhigh");
		expect(parseEffortDirective("\teffort:\tultra\t")).toBe("ultra");
	});

	it("finds the directive among other lines in a description", () => {
		const text = [
			"Please refactor the auth module.",
			"Effort: high",
			"Make sure tests pass.",
		].join("\n");
		expect(parseEffortDirective(text)).toBe("high");
	});

	it("returns the LAST directive when multiple are present (latest wins)", () => {
		const text = ["Effort: low", "actually,", "Effort: max"].join("\n");
		expect(parseEffortDirective(text)).toBe("max");
	});

	it("does not match effort mentioned in prose", () => {
		expect(parseEffortDirective("The effort was high on this one.")).toBeNull();
		expect(
			parseEffortDirective("This needs maximum effort: please."),
		).toBeNull();
	});

	it("does not match unknown levels", () => {
		expect(parseEffortDirective("Effort: turbo")).toBeNull();
		expect(parseEffortDirective("Effort: extreme")).toBeNull();
	});

	it("does not match without the colon", () => {
		expect(parseEffortDirective("Effort high")).toBeNull();
	});
});
