import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OpenCodeMessageFormatter } from "../src/formatter.js";

interface ReplayEvent {
	type: string;
	part?: {
		tool?: string;
		state?: {
			status?: string;
			input?: unknown;
			output?: unknown;
			metadata?: unknown;
		};
	};
}

function loadFixture(): ReplayEvent[] {
	const url = new URL("./fixtures/opencode-run-sample.jsonl", import.meta.url);
	return readFileSync(url, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as ReplayEvent);
}

describe("OpenCodeMessageFormatter replay", () => {
	it("formats tool interactions from replayed OpenCode events", () => {
		const formatter = new OpenCodeMessageFormatter();
		const interactions = loadFixture().filter(
			(event) => event.type === "tool_use" && event.part?.state?.output,
		);

		expect(interactions.length).toBeGreaterThan(0);

		for (const event of interactions) {
			const toolName = event.part?.tool || "unknown";
			const input = event.part?.state?.input ?? {};
			const output = event.part?.state?.output ?? "";
			const isError = event.part?.state?.status === "error";

			expect(
				formatter.formatToolActionName(toolName, input, isError).trim(),
			).not.toBe("");
			expect(formatter.formatToolParameter(toolName, input).trim()).not.toBe(
				"",
			);
			expect(
				formatter
					.formatToolResult(
						toolName,
						input,
						typeof output === "string" ? output : JSON.stringify(output),
						isError,
					)
					.trim(),
			).not.toBe("");
		}
	});
});
