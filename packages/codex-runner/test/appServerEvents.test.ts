import { describe, expect, it } from "vitest";
import { translateAppServerItem } from "../src/backend/appServerEvents.js";

describe("translateAppServerItem", () => {
	it("maps a real app-server commandExecution item to snake_case", () => {
		// Shape captured from a live `codex app-server` coding turn.
		const item = {
			type: "commandExecution",
			id: "call_abc",
			command: "/bin/zsh -lc 'ls -la'",
			cwd: "/tmp/x",
			processId: "123",
			source: "unifiedExecStartup",
			status: "completed",
			commandActions: [{ type: "unknown", command: "ls -la" }],
			aggregatedOutput: "total 0\nREADME.md\n",
			exitCode: 0,
			durationMs: 12,
		};
		expect(translateAppServerItem(item)).toEqual({
			type: "command_execution",
			id: "call_abc",
			command: "/bin/zsh -lc 'ls -la'",
			aggregated_output: "total 0\nREADME.md\n",
			exit_code: 0,
			status: "completed",
		});
	});

	it("maps inProgress status to in_progress and omits missing exit code", () => {
		const result = translateAppServerItem({
			type: "commandExecution",
			id: "c2",
			command: "sleep 1",
			aggregatedOutput: "",
			status: "inProgress",
		});
		expect(result).toMatchObject({
			type: "command_execution",
			status: "in_progress",
		});
		expect(result && "exit_code" in result).toBe(false);
	});

	it("treats declined command status as failed", () => {
		expect(
			translateAppServerItem({
				type: "commandExecution",
				id: "c3",
				command: "rm -rf /",
				aggregatedOutput: "",
				status: "declined",
			}),
		).toMatchObject({ status: "failed" });
	});

	it("maps fileChange (with v2 diff field) to normalized changes", () => {
		expect(
			translateAppServerItem({
				type: "fileChange",
				id: "f1",
				status: "completed",
				changes: [
					{ path: "src/a.ts", kind: "update", diff: "@@ -1 +1 @@" },
					{ path: "src/b.ts", kind: "add", diff: "+new" },
				],
			}),
		).toEqual({
			type: "file_change",
			id: "f1",
			status: "completed",
			changes: [
				{ path: "src/a.ts", kind: "update" },
				{ path: "src/b.ts", kind: "add" },
			],
		});
	});

	it("maps mcpToolCall, normalizing structuredContent -> structured_content", () => {
		const result = translateAppServerItem({
			type: "mcpToolCall",
			id: "m1",
			server: "linear",
			tool: "get_issue",
			arguments: { id: "ABC-1" },
			status: "completed",
			result: {
				content: [{ type: "text", text: "ok" }],
				structuredContent: { a: 1 },
			},
		});
		expect(result).toEqual({
			type: "mcp_tool_call",
			id: "m1",
			server: "linear",
			tool: "get_issue",
			arguments: { id: "ABC-1" },
			status: "completed",
			result: {
				content: [{ type: "text", text: "ok" }],
				structured_content: { a: 1 },
			},
		});
	});

	it("maps agentMessage to agent_message text", () => {
		expect(
			translateAppServerItem({
				type: "agentMessage",
				id: "msg1",
				text: "hello",
				phase: "final_answer",
				memoryCitation: null,
			}),
		).toEqual({ type: "agent_message", id: "msg1", text: "hello" });
	});

	it("maps webSearch with action through", () => {
		expect(
			translateAppServerItem({
				type: "webSearch",
				id: "w1",
				query: "tcp handshake",
				action: { type: "search" },
			}),
		).toEqual({
			type: "web_search",
			id: "w1",
			query: "tcp handshake",
			action: { type: "search" },
		});
	});

	it("returns null for non-rendered item types and junk", () => {
		expect(
			translateAppServerItem({ type: "plan", id: "p1", text: "x" }),
		).toBeNull();
		expect(translateAppServerItem(null)).toBeNull();
		expect(translateAppServerItem("nope")).toBeNull();
	});

	it("maps reasoning / userMessage to placeholder items", () => {
		expect(translateAppServerItem({ type: "reasoning", id: "r1" })).toEqual({
			type: "reasoning",
			id: "r1",
		});
		expect(translateAppServerItem({ type: "userMessage", id: "u1" })).toEqual({
			type: "user_message",
			id: "u1",
		});
	});
});

it("maps actual contained app-server dynamic tool start/result instead of dropping them", () => {
	const start = {
		type: "dynamicToolCall",
		id: "call_fixture",
		namespace: null,
		tool: "get_issue",
		arguments: {},
		status: "inProgress",
		contentItems: null,
		success: null,
		durationMs: null,
	};
	expect(translateAppServerItem(start)).toEqual({
		type: "dynamic_tool_call",
		id: "call_fixture",
		tool: "get_issue",
		arguments: {},
		status: "in_progress",
		text: "",
	});
	expect(
		translateAppServerItem({
			...start,
			status: "completed",
			contentItems: [{ type: "inputText", text: "Scoped issue content" }],
			success: true,
		}),
	).toEqual({
		type: "dynamic_tool_call",
		id: "call_fixture",
		tool: "get_issue",
		arguments: {},
		status: "completed",
		text: "Scoped issue content",
	});
	expect(
		translateAppServerItem({ ...start, status: "completed", success: false }),
	).toMatchObject({ status: "failed" });
});
