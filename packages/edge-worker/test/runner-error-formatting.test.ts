import { describe, expect, it } from "vitest";
import {
	formatModelApiError,
	isModelApiErrorText,
} from "../src/runner-error-formatting";

describe("isModelApiErrorText", () => {
	it("detects the canonical Claude API error text", () => {
		expect(isModelApiErrorText("API Error: Internal server error")).toBe(true);
	});

	it("detects API errors with leading/trailing whitespace", () => {
		expect(isModelApiErrorText("  \nAPI Error: Request timed out.\n")).toBe(
			true,
		);
	});

	it("detects API errors with status codes and JSON bodies", () => {
		expect(
			isModelApiErrorText(
				'API Error: 500 {"type":"error","error":{"message":"Internal server error"}}',
			),
		).toBe(true);
	});

	it("is case-insensitive", () => {
		expect(isModelApiErrorText("api error: overloaded")).toBe(true);
	});

	it("does not match a normal response that merely mentions an API error", () => {
		expect(
			isModelApiErrorText(
				"I added handling for the API Error: Internal server error case.",
			),
		).toBe(false);
	});

	it("returns false for empty/undefined/null", () => {
		expect(isModelApiErrorText("")).toBe(false);
		expect(isModelApiErrorText(undefined)).toBe(false);
		expect(isModelApiErrorText(null)).toBe(false);
	});
});

describe("formatModelApiError", () => {
	it("attributes the error to Claude with a clear prefix", () => {
		expect(
			formatModelApiError("API Error: Internal server error", "claude"),
		).toBe(
			"⚠️ **Claude API error** — this error came from Claude's API, not from Cyrus.\n\nAPI Error: Internal server error",
		);
	});

	it("uses the right display name per runner type", () => {
		expect(formatModelApiError("API Error: boom", "gemini")).toContain(
			"**Gemini API error**",
		);
		expect(formatModelApiError("API Error: boom", "codex")).toContain(
			"**Codex API error**",
		);
		expect(formatModelApiError("API Error: boom", "cursor")).toContain(
			"**Cursor API error**",
		);
	});

	it("falls back to a generic label for unknown runner types", () => {
		expect(formatModelApiError("API Error: boom", "mystery")).toContain(
			"**the agent API error**",
		);
	});

	it("trims the underlying content", () => {
		expect(
			formatModelApiError("  API Error: Internal server error  ", "claude"),
		).toBe(
			"⚠️ **Claude API error** — this error came from Claude's API, not from Cyrus.\n\nAPI Error: Internal server error",
		);
	});
});
