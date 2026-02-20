import { describe, expect, it } from "vitest";
import { CursorMessageFormatter } from "../src/formatter.js";

describe("CursorMessageFormatter", () => {
	const formatter = new CursorMessageFormatter();

	it("formats TodoWrite todos as markdown checklist", () => {
		const formatted = formatter.formatTodoWriteParameter(
			JSON.stringify({
				todos: [
					{ content: "implement runner", status: "in_progress" },
					{ content: "run tests", status: "pending" },
					{ content: "ship", status: "completed" },
				],
			}),
		);
		expect(formatted).toContain("- [ ] implement runner (in progress)");
		expect(formatted).toContain("- [ ] run tests");
		expect(formatted).toContain("- [x] ship");
	});

	it("formats Cursor API TODO_STATUS_* status values as markdown checklist", () => {
		const formatted = formatter.formatTodoWriteParameter(
			JSON.stringify({
				todos: [
					{ content: "Buy groceries", status: "TODO_STATUS_COMPLETED" },
					{ content: "Fix faucet", status: "TODO_STATUS_IN_PROGRESS" },
					{ content: "Reply to email", status: "TODO_STATUS_PENDING" },
				],
			}),
		);
		expect(formatted).toContain("- [x] Buy groceries");
		expect(formatted).toContain("- [ ] Fix faucet (in progress)");
		expect(formatted).toContain("- [ ] Reply to email");
	});

	it("formats tool parameters using command when present", () => {
		const formatted = formatter.formatToolParameter("Bash", {
			command: "pnpm test",
		});
		expect(formatted).toBe("pnpm test");
	});
});
