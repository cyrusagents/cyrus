import { describe, expect, it } from "vitest";
import { CursorRunner } from "../src/CursorRunner.js";

function createRunner(): CursorRunner {
	return new CursorRunner({
		cyrusHome: "/tmp/cyrus",
		workingDirectory: "/tmp/repo",
	});
}

describe("CursorRunner tool event mapping", () => {
	it("maps legacy gpt-5 model alias to a Cursor-supported model argument", () => {
		const runner = new CursorRunner({
			cyrusHome: "/tmp/cyrus",
			workingDirectory: "/tmp/repo",
			model: "gpt-5",
		});
		const args = (runner as any).buildArgs("hello");
		const modelFlagIndex = args.indexOf("--model");

		expect(modelFlagIndex).toBeGreaterThan(-1);
		expect(args[modelFlagIndex + 1]).toBe("auto");
	});

	it("maps command_execution item.completed to assistant tool_use + user tool_result", () => {
		const runner = createRunner();
		(runner as any).sessionInfo = {
			sessionId: "session-1",
			startedAt: new Date(),
			isRunning: true,
		};

		(runner as any).handleEvent({
			type: "item.completed",
			item: {
				id: "item-1",
				type: "command_execution",
				status: "completed",
				command: "rg -n CursorRunner packages",
				aggregated_output: "packages/cursor-runner/src/CursorRunner.ts",
				exit_code: 0,
			},
		});

		const messages = runner.getMessages();
		expect(
			messages.find((message) => message.type === "assistant"),
		).toBeDefined();
		expect(messages.find((message) => message.type === "user")).toBeDefined();
	});

	it("does not emit duplicate tool_use for started + completed pair", () => {
		const runner = createRunner();
		(runner as any).sessionInfo = {
			sessionId: "session-1",
			startedAt: new Date(),
			isRunning: true,
		};

		(runner as any).handleEvent({
			type: "item.started",
			item: {
				id: "item-2",
				type: "command_execution",
				status: "started",
				command: "git status",
			},
		});
		(runner as any).handleEvent({
			type: "item.completed",
			item: {
				id: "item-2",
				type: "command_execution",
				status: "completed",
				command: "git status",
				aggregated_output: "On branch main",
				exit_code: 0,
			},
		});

		const assistantMessages = runner
			.getMessages()
			.filter((message) => message.type === "assistant");
		expect(assistantMessages).toHaveLength(1);
	});

	it("maps assistant event schema to an assistant message", () => {
		const runner = createRunner();
		(runner as any).sessionInfo = {
			sessionId: "session-1",
			startedAt: new Date(),
			isRunning: true,
		};

		(runner as any).handleEvent({
			type: "assistant",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "cursor runner works" }],
			},
		});

		const assistantMessage = runner
			.getMessages()
			.find((message) => message.type === "assistant");
		expect(assistantMessage).toBeDefined();
	});

	it("maps tool_call started/completed events to tool_use + tool_result", () => {
		const runner = createRunner();
		(runner as any).sessionInfo = {
			sessionId: "session-1",
			startedAt: new Date(),
			isRunning: true,
		};

		(runner as any).handleEvent({
			type: "tool_call",
			subtype: "started",
			call_id: "tool-1",
			tool_call: {
				shellToolCall: {
					args: {
						command: "git status",
					},
				},
			},
		});
		(runner as any).handleEvent({
			type: "tool_call",
			subtype: "completed",
			call_id: "tool-1",
			tool_call: {
				shellToolCall: {
					args: {
						command: "git status",
					},
					result: {
						success: {
							stdout: "On branch cypack-804",
						},
					},
				},
			},
		});

		const messages = runner.getMessages();
		const assistantMessages = messages.filter(
			(message) => message.type === "assistant",
		);
		const userMessages = messages.filter((message) => message.type === "user");

		expect(assistantMessages).toHaveLength(1);
		expect(userMessages).toHaveLength(1);
	});
});
