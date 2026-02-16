import { ClaudeMessageFormatter } from "cyrus-claude-runner";
import { describe, expect, test } from "vitest";

describe("AgentSessionManager - Tool Formatting", () => {
	// Create formatter instance to test
	const formatter = new ClaudeMessageFormatter();

	test("formatToolParameter - Bash tool with description", () => {
		const result = formatter.formatToolParameter("Bash", {
			command: "ls -la /home/user",
			description: "List files in home directory",
		});

		// Should show command only - description goes in action field via formatToolActionName
		expect(result).toBe("ls -la /home/user");
	});

	test("formatToolParameter - Bash tool without description", () => {
		const result = formatter.formatToolParameter("Bash", {
			command: "ls -la /home/user",
		});

		expect(result).toBe("ls -la /home/user");
	});

	test("formatToolParameter - Read tool with file path", () => {
		const result = formatter.formatToolParameter("Read", {
			file_path: "/home/user/test.ts",
		});

		expect(result).toBe("/home/user/test.ts");
	});

	test("formatToolParameter - Read tool with line range", () => {
		const result = formatter.formatToolParameter("Read", {
			file_path: "/home/user/test.ts",
			offset: 10,
			limit: 20,
		});

		expect(result).toBe("/home/user/test.ts (lines 11-30)");
	});

	test("formatToolParameter - Grep tool with pattern", () => {
		const result = formatter.formatToolParameter("Grep", {
			pattern: "TODO",
			path: "/home/user",
			glob: "*.ts",
		});

		expect(result).toBe("Pattern: `TODO` in /home/user (*.ts)");
	});

	test("formatToolParameter - Glob tool with pattern", () => {
		const result = formatter.formatToolParameter("Glob", {
			pattern: "**/*.ts",
			path: "/home/user",
		});

		expect(result).toBe("Pattern: `**/*.ts` in /home/user");
	});

	test("formatToolParameter - WebSearch tool with query", () => {
		const result = formatter.formatToolParameter("WebSearch", {
			query: "Linear API documentation",
		});

		expect(result).toBe("Query: Linear API documentation");
	});

	test("formatToolParameter - MCP tool extracts meaningful field", () => {
		const result = formatter.formatToolParameter("mcp__linear__get_issue", {
			id: "CYPACK-395",
			someOtherField: "value",
		});

		expect(result).toBe("id: CYPACK-395");
	});

	test("formatToolResult - Bash tool with output", () => {
		const result = formatter.formatToolResult(
			"Bash",
			{ command: "echo hello", description: "Test command" },
			"hello\nworld",
			false,
		);

		expect(result).toContain("```\nhello\nworld\n```");
	});

	test("formatToolResult - Bash tool without output", () => {
		const result = formatter.formatToolResult(
			"Bash",
			{ command: "touch file.txt", description: "Create file" },
			"",
			false,
		);

		expect(result).toContain("*No output*");
	});

	test("formatToolResult - Read tool with TypeScript file", () => {
		const result = formatter.formatToolResult(
			"Read",
			{ file_path: "/home/user/test.ts" },
			"const x = 1;\nconsole.log(x);",
			false,
		);

		expect(result).toContain(
			"```typescript\nconst x = 1;\nconsole.log(x);\n```",
		);
	});

	test("formatToolResult - Read tool removes line numbers and system-reminder", () => {
		const resultWithLineNumbers =
			"  25→def foo():\n  26→    return 1\n\n<system-reminder>\nThis is a reminder\n</system-reminder>";

		const result = formatter.formatToolResult(
			"Read",
			{ file_path: "/home/user/test.py" },
			resultWithLineNumbers,
			false,
		);

		// Should not contain line numbers or system-reminder
		expect(result).not.toContain("25→");
		expect(result).not.toContain("26→");
		expect(result).not.toContain("<system-reminder>");
		expect(result).toContain("```python\ndef foo():\n    return 1\n```");
	});

	test("formatToolResult - Read tool preserves first line indentation", () => {
		// Simulate Read output where the first line has indentation
		// This reproduces the bug from CYPACK-401 where first line indentation is stripped
		const resultWithLineNumbers =
			'  16→            coordinate["x"] -= 1\n  17→            elif direction == "up":\n  18→                coordinate["y"] += 1';

		const result = formatter.formatToolResult(
			"Read",
			{ file_path: "/home/user/test.py" },
			resultWithLineNumbers,
			false,
		);

		// Should not contain line numbers
		expect(result).not.toContain("16→");
		expect(result).not.toContain("17→");
		expect(result).not.toContain("18→");

		// CRITICAL: First line should preserve its 12 spaces of indentation
		// All three lines should have the same indentation level
		expect(result).toContain(
			'```python\n            coordinate["x"] -= 1\n            elif direction == "up":\n                coordinate["y"] += 1\n```',
		);
	});

	test("formatToolResult - Edit tool shows diff format", () => {
		const result = formatter.formatToolResult(
			"Edit",
			{
				file_path: "/home/user/test.ts",
				old_string: "const x = 1;",
				new_string: "const x = 2;",
			},
			"",
			false,
		);

		// Should be formatted as a diff
		expect(result).toContain("```diff");
		expect(result).toContain("-const x = 1;");
		expect(result).toContain("+const x = 2;");
	});

	test("formatToolResult - Grep tool with file matches", () => {
		const result = formatter.formatToolResult(
			"Grep",
			{ pattern: "TODO" },
			"file1.ts\nfile2.ts\nfile3.ts",
			false,
		);

		expect(result).toContain("Found 3 matching files:");
		expect(result).toContain("```\nfile1.ts\nfile2.ts\nfile3.ts\n```");
	});

	test("formatToolResult - Glob tool with results", () => {
		const result = formatter.formatToolResult(
			"Glob",
			{ pattern: "*.ts" },
			"file1.ts\nfile2.ts",
			false,
		);

		expect(result).toContain("Found 2 matching files:");
		expect(result).toContain("```\nfile1.ts\nfile2.ts\n```");
	});

	test("formatToolResult - Error result", () => {
		const result = formatter.formatToolResult(
			"Bash",
			{ command: "invalid command" },
			"Error: command not found",
			true,
		);

		expect(result).toBe("```\nError: command not found\n```");
	});

	test("formatToolResult - Write tool success", () => {
		const result = formatter.formatToolResult(
			"Write",
			{ file_path: "/home/user/test.ts" },
			"",
			false,
		);

		expect(result).toBe("*File written successfully*");
	});

	test("formatToolParameter - handles arrow prefix for subtasks", () => {
		const result = formatter.formatToolParameter("↪ Bash", {
			command: "pwd",
			description: "Get current directory",
		});

		// Should show command only - description goes in action field via formatToolActionName
		expect(result).toBe("pwd");
	});

	test("formatToolResult - handles arrow prefix for subtasks", () => {
		const result = formatter.formatToolResult(
			"↪ Read",
			{ file_path: "/home/user/test.js" },
			"console.log('test');",
			false,
		);

		expect(result).toContain("```javascript\nconsole.log('test');\n```");
	});

	test("formatToolActionName - Bash tool with description", () => {
		const result = formatter.formatToolActionName(
			"Bash",
			{
				command: "ls -la",
				description: "List all files",
			},
			false,
		);

		// Should show action name with description in round brackets
		expect(result).toBe("Bash (List all files)");
	});

	test("formatToolActionName - Bash tool without description", () => {
		const result = formatter.formatToolActionName(
			"Bash",
			{
				command: "ls -la",
			},
			false,
		);

		// Should show action name without description
		expect(result).toBe("Bash");
	});

	test("formatToolActionName - Bash tool with error and description", () => {
		const result = formatter.formatToolActionName(
			"Bash",
			{
				command: "invalid command",
				description: "Test command",
			},
			true,
		);

		// Should show error with description
		expect(result).toBe("Bash (Error) (Test command)");
	});

	test("formatToolActionName - subtask Bash tool with description", () => {
		const result = formatter.formatToolActionName(
			"↪ Bash",
			{
				command: "pwd",
				description: "Get current directory",
			},
			false,
		);

		// Should show subtask action name with description
		expect(result).toBe("↪ Bash (Get current directory)");
	});

	test("formatToolActionName - other tools without special formatting", () => {
		const result = formatter.formatToolActionName(
			"Read",
			{ file_path: "/test" },
			false,
		);

		// Should show action name without modification for non-Bash tools
		expect(result).toBe("Read");
	});

	// Task tool formatting tests
	test("formatToolParameter - TaskCreate shows concise pending checklist item", () => {
		const result = formatter.formatToolParameter("TaskCreate", {
			subject: "Implement user authentication",
			description: "Add OAuth login flow with Google provider",
			activeForm: "Implementing user authentication",
		});

		expect(result).toBe("⏳ **Implement user authentication**");
	});

	test("formatToolParameter - TaskCreate with only subject", () => {
		const result = formatter.formatToolParameter("TaskCreate", {
			subject: "Fix bug in login page",
			description: "Fix bug in login page",
		});

		expect(result).toBe("⏳ **Fix bug in login page**");
	});

	test("formatToolParameter - TaskUpdate with status completed", () => {
		const result = formatter.formatToolParameter("TaskUpdate", {
			taskId: "123",
			status: "completed",
		});

		expect(result).toBe("✅ Task #123");
	});

	test("formatToolParameter - TaskUpdate with status completed and subject", () => {
		const result = formatter.formatToolParameter("TaskUpdate", {
			taskId: "123",
			status: "completed",
			subject: "Authentication implemented",
		});

		expect(result).toBe("✅ Task #123 — Authentication implemented");
	});

	test("formatToolParameter - TaskUpdate with status in_progress", () => {
		const result = formatter.formatToolParameter("TaskUpdate", {
			taskId: "456",
			status: "in_progress",
		});

		expect(result).toBe("🔄 Task #456");
	});

	test("formatToolParameter - TaskUpdate with status deleted", () => {
		const result = formatter.formatToolParameter("TaskUpdate", {
			taskId: "789",
			status: "deleted",
		});

		expect(result).toBe("🗑️ Task #789");
	});

	test("formatToolParameter - TaskGet shows task number only", () => {
		const result = formatter.formatToolParameter("TaskGet", {
			taskId: "999",
		});

		expect(result).toBe("📋 Task #999");
	});

	test("formatToolParameter - TaskGet with subject", () => {
		const result = formatter.formatToolParameter("TaskGet", {
			taskId: "999",
			subject: "Fix authentication bug",
		});

		expect(result).toBe("📋 Task #999 — Fix authentication bug");
	});

	test("formatToolParameter - TaskList", () => {
		const result = formatter.formatToolParameter("TaskList", {});

		expect(result).toBe("📋 List all tasks");
	});

	test("formatToolParameter - TaskCreate delegates to formatTaskParameter", () => {
		const result = formatter.formatToolParameter("TaskCreate", {
			subject: "Test task",
			description: "Test description",
		});

		expect(result).toBe("⏳ **Test task**");
	});

	test("formatToolParameter - TaskUpdate with arrow prefix", () => {
		const result = formatter.formatToolParameter("↪ TaskUpdate", {
			taskId: "111",
			status: "completed",
		});

		expect(result).toBe("✅ Task #111");
	});

	test("formatToolParameter - TaskUpdate with arrow prefix and subject", () => {
		const result = formatter.formatToolParameter("↪ TaskUpdate", {
			taskId: "111",
			status: "completed",
			subject: "Task done",
		});

		expect(result).toBe("✅ Task #111 — Task done");
	});

	test("formatToolResult - TaskCreate success", () => {
		const result = formatter.formatToolResult(
			"TaskCreate",
			{ subject: "New task" },
			"Task created with ID: task-123",
			false,
		);

		expect(result).toContain("*Task created*");
		expect(result).toContain("Task created with ID: task-123");
	});

	test("formatToolResult - TaskUpdate success", () => {
		const result = formatter.formatToolResult(
			"TaskUpdate",
			{ taskId: "123" },
			"Task updated successfully",
			false,
		);

		expect(result).toBe("Task updated successfully");
	});

	test("formatToolResult - TaskList with tasks", () => {
		const taskList =
			"1. Task A (pending)\n2. Task B (completed)\n3. Task C (in_progress)";
		const result = formatter.formatToolResult("TaskList", {}, taskList, false);

		expect(result).toContain("```");
		expect(result).toContain(taskList);
	});

	test("formatToolResult - TaskGet with task details", () => {
		const taskDetails =
			"ID: 123\nSubject: Fix bug\nStatus: in_progress\nDescription: Fix login bug";
		const result = formatter.formatToolResult(
			"TaskGet",
			{ taskId: "123" },
			taskDetails,
			false,
		);

		expect(result).toContain("```");
		expect(result).toContain(taskDetails);
	});

	// ToolSearch formatting tests
	test("formatToolParameter - ToolSearch with select query", () => {
		const result = formatter.formatToolParameter("ToolSearch", {
			query: "select:mcp__linear__get_issue",
			max_results: 1,
		});

		expect(result).toBe("mcp__linear__get_issue");
	});

	test("formatToolParameter - ToolSearch with keyword search", () => {
		const result = formatter.formatToolParameter("ToolSearch", {
			query: "+linear get_issue",
			max_results: 3,
		});

		expect(result).toBe("+linear get_issue");
	});

	test("formatToolParameter - ToolSearch with arrow prefix", () => {
		const result = formatter.formatToolParameter("↪ ToolSearch", {
			query: "select:mcp__slack__read_channel",
			max_results: 1,
		});

		expect(result).toBe("mcp__slack__read_channel");
	});

	test("formatToolResult - ToolSearch with results", () => {
		const result = formatter.formatToolResult(
			"ToolSearch",
			{ query: "select:mcp__linear__get_issue" },
			"Found tool: mcp__linear__get_issue",
			false,
		);

		expect(result).toBe("*Found tool: mcp__linear__get_issue*");
	});

	test("formatToolResult - ToolSearch with no results", () => {
		const result = formatter.formatToolResult(
			"ToolSearch",
			{ query: "nonexistent" },
			"",
			false,
		);

		expect(result).toBe("*No tools found*");
	});

	// TaskOutput formatting tests
	test("formatToolParameter - TaskOutput blocking", () => {
		const result = formatter.formatToolParameter("TaskOutput", {
			task_id: "b6e6efb",
			block: true,
			timeout: 120000,
		});

		expect(result).toBe("📤 Waiting for task b6e6efb");
	});

	test("formatToolParameter - TaskOutput non-blocking", () => {
		const result = formatter.formatToolParameter("TaskOutput", {
			task_id: "abc123",
			block: false,
			timeout: 30000,
		});

		expect(result).toBe("📤 Checking task abc123");
	});

	test("formatToolParameter - TaskOutput with arrow prefix", () => {
		const result = formatter.formatToolParameter("↪ TaskOutput", {
			task_id: "def456",
			block: true,
			timeout: 60000,
		});

		expect(result).toBe("📤 Waiting for task def456");
	});

	test("formatToolResult - TaskOutput with short result", () => {
		const result = formatter.formatToolResult(
			"TaskOutput",
			{ task_id: "abc123" },
			"Task completed successfully",
			false,
		);

		expect(result).toBe("Task completed successfully");
	});

	test("formatToolResult - TaskOutput with long multiline result", () => {
		const longResult = `Line 1\nLine 2\nLine 3\n${"More output ".repeat(20)}`;
		const result = formatter.formatToolResult(
			"TaskOutput",
			{ task_id: "abc123" },
			longResult,
			false,
		);

		expect(result).toContain("```");
		expect(result).toContain(longResult);
	});

	test("formatToolResult - TaskOutput with no output", () => {
		const result = formatter.formatToolResult(
			"TaskOutput",
			{ task_id: "abc123" },
			"",
			false,
		);

		expect(result).toBe("*No output yet*");
	});
});
