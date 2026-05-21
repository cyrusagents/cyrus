import { describe, expect, it } from "vitest";
import {
	appendFailureModeAddendum,
	FAILURE_MODE_PROMPT_ADDENDUM,
} from "../src/prompts/failureModePromptAddendum.js";

describe("failure-mode prompt addendum", () => {
	it("includes the MCP tool name and trigger conditions", () => {
		expect(FAILURE_MODE_PROMPT_ADDENDUM).toContain(
			"mcp__cyrus-tools__log_failure_mode",
		);
		expect(FAILURE_MODE_PROMPT_ADDENDUM).toMatch(/dissatisfaction/i);
		expect(FAILURE_MODE_PROMPT_ADDENDUM).toMatch(/3\+/);
	});

	it("appends the addendum to an existing system prompt with a blank-line separator", () => {
		const result = appendFailureModeAddendum("You are Cyrus.");
		expect(result.startsWith("You are Cyrus.\n\n")).toBe(true);
		expect(result.endsWith(FAILURE_MODE_PROMPT_ADDENDUM)).toBe(true);
	});

	it("returns the addendum verbatim when no base prompt is provided", () => {
		expect(appendFailureModeAddendum(undefined)).toBe(
			FAILURE_MODE_PROMPT_ADDENDUM,
		);
		expect(appendFailureModeAddendum(null)).toBe(FAILURE_MODE_PROMPT_ADDENDUM);
		expect(appendFailureModeAddendum("")).toBe(FAILURE_MODE_PROMPT_ADDENDUM);
	});

	it("trims trailing whitespace from the existing prompt before joining", () => {
		const result = appendFailureModeAddendum("Existing.\n\n   \n");
		expect(result).toBe(`Existing.\n\n${FAILURE_MODE_PROMPT_ADDENDUM}`);
	});
});
