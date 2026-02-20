import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CursorMessageFormatter } from "../src/formatter.js";

describe("CursorMessageFormatter replay", () => {
	it("formats representative item.completed command payloads", () => {
		const url = new URL("./fixtures/cursor-exec-sample.jsonl", import.meta.url);
		const lines = readFileSync(url, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as Record<string, unknown>);

		const formatter = new CursorMessageFormatter();
		const commandItems = lines
			.filter((event) => event.type === "item.completed")
			.map((event) => event.item as Record<string, unknown>)
			.filter((item) => item?.type === "command_execution");

		expect(commandItems.length).toBeGreaterThan(0);
		for (const item of commandItems) {
			const command = typeof item.command === "string" ? item.command : "";
			const formatted = formatter.formatToolParameter("Bash", { command });
			expect(formatted.length).toBeGreaterThan(0);
		}
	});
});
