import { describe, expect, it } from "vitest";
import { CodexMessageFormatter } from "../src/formatter.js";

describe("CodexMessageFormatter", () => {
	const formatter = new CodexMessageFormatter();

	it("formats command tool input", () => {
		const formatted = formatter.formatToolParameter("Bash", {
			command: "ls -la",
			description: "List files",
		});
		expect(formatted).toBe("ls -la");
	});

	it("formats read tool input with line range", () => {
		const formatted = formatter.formatToolParameter("Read", {
			file_path: "src/index.ts",
			offset: 10,
			limit: 5,
		});
		expect(formatted).toBe("src/index.ts (lines 11-15)");
	});

	it("formats task tool input", () => {
		const formatted = formatter.formatTaskParameter("TaskUpdate", {
			taskId: "3",
			status: "in_progress",
			subject: "Add codex formatter tests",
		});
		expect(formatted).toBe("Task #3 in_progress: Add codex formatter tests");
	});

	it("formats task list action", () => {
		const formatted = formatter.formatTaskParameter("TaskList", {});
		expect(formatted).toBe("List all tasks");
	});

	it("formats todo items as markdown checklist lines", () => {
		const formatted = formatter.formatTodoWriteParameter(
			JSON.stringify({
				todos: [
					{ content: "Finished step", status: "completed" },
					{ content: "Pending step", status: "pending" },
					{ content: "Active step", status: "in_progress" },
				],
			}),
		);

		expect(formatted).toBe(
			"- [x] Finished step\n- [ ] Pending step\n- [ ] Active step (in progress)",
		);
	});

	it("wraps error results in code fences", () => {
		const formatted = formatter.formatToolResult(
			"Bash",
			{ command: "bad-cmd" },
			"command not found",
			true,
		);
		expect(formatted).toBe("```\ncommand not found\n```");
	});

	it("truncates long tool output", () => {
		const longOutput = "x".repeat(4200);
		const formatted = formatter.formatToolResult("Read", {}, longOutput, false);
		expect(formatted.endsWith("\n\n[truncated]")).toBe(true);
		expect(formatted.length).toBeLessThan(4200);
	});
});
