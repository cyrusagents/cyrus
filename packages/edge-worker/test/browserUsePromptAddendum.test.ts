import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	appendBrowserUseAddendum,
	BROWSER_USE_PROMPT_ADDENDUM,
} from "../src/prompts/browserUsePromptAddendum.js";

describe("browser-use prompt addendum", () => {
	const original = process.env.MIKO_BROWSER_USE_ENABLED;

	beforeEach(() => {
		delete process.env.MIKO_BROWSER_USE_ENABLED;
	});

	afterEach(() => {
		if (original === undefined) delete process.env.MIKO_BROWSER_USE_ENABLED;
		else process.env.MIKO_BROWSER_USE_ENABLED = original;
	});

	it("includes the agent-browser CLI name and a screenshot hint", () => {
		expect(BROWSER_USE_PROMPT_ADDENDUM).toContain("agent-browser");
		expect(BROWSER_USE_PROMPT_ADDENDUM).toMatch(/screenshot/i);
	});

	it("returns the existing prompt unchanged when the env var is unset", () => {
		expect(appendBrowserUseAddendum("You are Miko.")).toBe("You are Miko.");
		expect(appendBrowserUseAddendum(undefined)).toBe("");
		expect(appendBrowserUseAddendum(null)).toBe("");
	});

	it("returns the existing prompt unchanged when the env var is falsy", () => {
		process.env.MIKO_BROWSER_USE_ENABLED = "false";
		expect(appendBrowserUseAddendum("You are Miko.")).toBe("You are Miko.");
		process.env.MIKO_BROWSER_USE_ENABLED = "0";
		expect(appendBrowserUseAddendum("You are Miko.")).toBe("You are Miko.");
	});

	it("appends the addendum with a blank-line separator when enabled", () => {
		process.env.MIKO_BROWSER_USE_ENABLED = "true";
		const result = appendBrowserUseAddendum("You are Miko.");
		expect(result.startsWith("You are Miko.\n\n")).toBe(true);
		expect(result.endsWith(BROWSER_USE_PROMPT_ADDENDUM)).toBe(true);
	});

	it("returns the addendum verbatim when enabled with no base prompt", () => {
		process.env.MIKO_BROWSER_USE_ENABLED = "1";
		expect(appendBrowserUseAddendum(undefined)).toBe(
			BROWSER_USE_PROMPT_ADDENDUM,
		);
		expect(appendBrowserUseAddendum("")).toBe(BROWSER_USE_PROMPT_ADDENDUM);
	});

	it("accepts common truthy spellings", () => {
		for (const value of ["true", "1", "yes", "TRUE", " Yes "]) {
			process.env.MIKO_BROWSER_USE_ENABLED = value;
			expect(appendBrowserUseAddendum("base")).toContain(
				BROWSER_USE_PROMPT_ADDENDUM,
			);
		}
	});
});
