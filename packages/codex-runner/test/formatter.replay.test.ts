import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CodexMessageFormatter } from "../src/formatter.js";

type ReplayEvent = {
	type: string;
	item?: {
		type?: string;
		command?: string;
		aggregated_output?: string;
		exit_code?: number | null;
		status?: string;
		changes?: Array<{ path?: string; kind?: string }>;
		action?: {
			type?: string;
			query?: string;
			queries?: string[];
			url?: string;
			pattern?: string;
		};
		query?: string;
	};
};

type ToolInteraction = {
	toolName: string;
	toolInput: Record<string, unknown>;
	result: string;
	isError: boolean;
};

function loadFixture(): ReplayEvent[] {
	const url = new URL("./fixtures/codex-exec-sample.jsonl", import.meta.url);
	const content = readFileSync(url, "utf8").trim();
	return content
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as ReplayEvent);
}

function inferToolFromCommand(command: string): string {
	if (/glob\.glob|packages\/\*\/package\.json/i.test(command)) return "Glob";
	if (/\brg\b\s+-n/i.test(command)) return "Grep";
	if (/cat\s+tmp\/codex-formatter-smoke\/sample\.txt/i.test(command))
		return "Read";
	if (/<<'EOF'\s*>\s*tmp\/codex-formatter-smoke\/generated\.txt/i.test(command))
		return "Write";
	if (/wc\s+-l\s+tmp\/codex-formatter-smoke\/generated\.txt/i.test(command))
		return "Bash";
	return "Bash";
}

function toolInputForCommand(
	toolName: string,
	command: string,
): Record<string, unknown> {
	if (toolName === "Grep") {
		const patternMatch =
			command.match(/rg\s+-n\s+"([^"]+)"/) ||
			command.match(/rg\s+-n\s+'([^']+)'/);
		return { pattern: patternMatch?.[1] ?? "unknown", path: "packages" };
	}
	if (toolName === "Glob") {
		return { pattern: "packages/*/package.json" };
	}
	if (toolName === "Read") {
		const fileMatch = command.match(/cat\s+([^'"\s]+)/);
		return { file_path: fileMatch?.[1] ?? "unknown" };
	}
	if (toolName === "Write") {
		return { file_path: "tmp/codex-formatter-smoke/generated.txt" };
	}
	return { command };
}

function buildInteractions(events: ReplayEvent[]): ToolInteraction[] {
	const interactions: ToolInteraction[] = [];

	for (const evt of events) {
		if (evt.type !== "item.completed" || !evt.item) continue;
		const item = evt.item;

		if (item.type === "command_execution") {
			const command = item.command ?? "";
			const toolName = inferToolFromCommand(command);
			const toolInput = toolInputForCommand(toolName, command);
			const isError =
				item.status === "failed" ||
				(typeof item.exit_code === "number" && item.exit_code !== 0);
			interactions.push({
				toolName,
				toolInput,
				result: item.aggregated_output ?? "",
				isError,
			});
			continue;
		}

		if (item.type === "file_change") {
			const first = item.changes?.[0];
			interactions.push({
				toolName: "Edit",
				toolInput: { file_path: first?.path ?? "unknown" },
				result: first
					? `${first.kind ?? "update"} ${first.path ?? "unknown"}`
					: "",
				isError: false,
			});
			continue;
		}

		if (item.type === "web_search") {
			const actionType = item.action?.type;
			if (actionType === "search") {
				interactions.push({
					toolName: "WebSearch",
					toolInput: { query: item.action?.query ?? item.query ?? "" },
					result: JSON.stringify(item.action ?? {}),
					isError: false,
				});
			} else {
				interactions.push({
					toolName: "WebFetch",
					toolInput: {
						url: item.action?.url ?? item.query ?? "",
						pattern: item.action?.pattern ?? "",
					},
					result: JSON.stringify(item.action ?? {}),
					isError: false,
				});
			}
		}
	}

	return interactions;
}

describe("CodexMessageFormatter replay", () => {
	it("covers expected tool families from real codex exec events", () => {
		const events = loadFixture();
		const interactions = buildInteractions(events);
		const seenTools = new Set(interactions.map((i) => i.toolName));

		expect(seenTools.has("Glob")).toBe(true);
		expect(seenTools.has("Grep")).toBe(true);
		expect(seenTools.has("Read")).toBe(true);
		expect(seenTools.has("Write")).toBe(true);
		expect(seenTools.has("Edit")).toBe(true);
		expect(seenTools.has("Bash")).toBe(true);
		expect(seenTools.has("WebSearch")).toBe(true);
		expect(seenTools.has("WebFetch")).toBe(true);
	});

	it("produces non-empty action/parameter/result for replayed interactions", () => {
		const formatter = new CodexMessageFormatter();
		const events = loadFixture();
		const interactions = buildInteractions(events);

		for (const interaction of interactions) {
			const action = formatter.formatToolActionName(
				interaction.toolName,
				interaction.toolInput,
				interaction.isError,
			);
			const parameter = formatter.formatToolParameter(
				interaction.toolName,
				interaction.toolInput,
			);
			const result = formatter.formatToolResult(
				interaction.toolName,
				interaction.toolInput,
				interaction.result,
				interaction.isError,
			);

			expect(action.trim().length).toBeGreaterThan(0);
			expect(parameter.trim().length).toBeGreaterThan(0);
			expect(result.trim().length).toBeGreaterThan(0);

			if (interaction.isError) {
				expect(result.startsWith("```")).toBe(true);
				expect(result.endsWith("```")).toBe(true);
			}
		}
	});
});
