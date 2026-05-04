import { describe, expect, it } from "vitest";
import {
	availableTools,
	getAllTools,
	getCoordinatorTools,
	getReadOnlyTools,
	getSafeTools,
	readOnlyTools,
	type ToolName,
	writeTools,
} from "../src/config";

describe("config", () => {
	describe("Tool Lists", () => {
		it("should define all available tools", () => {
			expect(availableTools).toEqual([
				"Read(**)",
				"Edit(**)",
				"Write(**)",
				"Glob",
				"Grep",
				"Bash",
				"Task",
				"WebFetch",
				"WebSearch",
				"TaskCreate",
				"TaskUpdate",
				"TaskGet",
				"TaskList",
				"NotebookEdit",
				"Skill",
				"AskUserQuestion",
				"SendMessage",
				"PushNotification",
				"EnterPlanMode",
				"ExitPlanMode",
				"EnterWorktree",
				"ExitWorktree",
				"CronCreate",
				"CronDelete",
				"CronList",
				"RemoteTrigger",
				"ScheduleWakeup",
				"Monitor",
				"TaskOutput",
				"TaskStop",
				"TeamCreate",
				"TeamDelete",
				"ToolSearch",
			]);
			expect(availableTools).toHaveLength(33);
		});

		it("should define read-only tools", () => {
			expect(readOnlyTools).toEqual([
				"Read(**)",
				"Glob",
				"Grep",
				"WebFetch",
				"WebSearch",
				"TaskCreate",
				"TaskUpdate",
				"TaskGet",
				"TaskList",
				"Task",
				"Skill",
				"Monitor",
				"TaskOutput",
				"EnterPlanMode",
				"ExitPlanMode",
				"ToolSearch",
			]);
			expect(readOnlyTools).toHaveLength(16);
		});

		it("should define write tools", () => {
			expect(writeTools).toEqual([
				"Edit(**)",
				"Write(**)",
				"Bash",
				"NotebookEdit",
			]);
			expect(writeTools).toHaveLength(4);
		});

		it("should have no overlap between read-only and write tools (task tools are read-only)", () => {
			const overlap = readOnlyTools.filter((tool) => writeTools.includes(tool));
			expect(overlap).toEqual([]);
		});

		it("should have all categorized tools in available tools", () => {
			const allCategorized = [...new Set([...readOnlyTools, ...writeTools])];
			allCategorized.forEach((tool) => {
				expect(availableTools).toContain(tool);
			});
		});
	});

	describe("Helper Functions", () => {
		it("getReadOnlyTools should return a copy of readOnlyTools", () => {
			const tools = getReadOnlyTools();

			// Should equal the original
			expect(tools).toEqual(readOnlyTools);

			// But should be a different array instance
			expect(tools).not.toBe(readOnlyTools);

			// Modifying returned array shouldn't affect original
			tools.push("NewTool" as ToolName);
			expect(readOnlyTools).not.toContain("NewTool");
		});

		it("getAllTools should return a copy of availableTools", () => {
			const tools = getAllTools();

			// Should equal the original
			expect(tools).toEqual(availableTools);

			// But should be a different array instance
			expect(tools).not.toBe(availableTools);

			// Modifying returned array shouldn't affect original
			tools.push("NewTool");
			expect(availableTools).not.toContain("NewTool");
		});

		it("getSafeTools should return all tools except Bash", () => {
			const tools = getSafeTools();

			expect(tools).toContain("Read(**)");
			expect(tools).toContain("Edit(**)");
			expect(tools).toContain("Write(**)");
			expect(tools).toContain("Glob");
			expect(tools).toContain("Grep");
			expect(tools).toContain("Task");
			expect(tools).toContain("WebFetch");
			expect(tools).toContain("WebSearch");
			expect(tools).toContain("TaskCreate");
			expect(tools).toContain("NotebookEdit");
			expect(tools).toContain("Skill");
			expect(tools).toContain("AskUserQuestion");
			expect(tools).not.toContain("Bash");

			// Should have all tools minus Bash
			expect(tools).toHaveLength(availableTools.length - 1);
		});

		it("getCoordinatorTools should return all tools except file editing tools", () => {
			const tools = getCoordinatorTools();

			// Should include read and execution tools
			expect(tools).toContain("Read(**)");
			expect(tools).toContain("Glob");
			expect(tools).toContain("Grep");
			expect(tools).toContain("Bash"); // For running tests/builds
			expect(tools).toContain("Task");
			expect(tools).toContain("WebFetch");
			expect(tools).toContain("WebSearch");
			expect(tools).toContain("TaskCreate"); // For task tracking
			expect(tools).toContain("Skill"); // For Skills functionality

			// Should NOT include file editing tools
			expect(tools).not.toContain("Edit(**)");
			expect(tools).not.toContain("Write(**)");
			expect(tools).not.toContain("NotebookEdit");

			// Should have all tools minus Edit, Write, NotebookEdit
			expect(tools).toHaveLength(availableTools.length - 3);
		});

		it("coordinator tools should allow reading and task tracking but not file editing", () => {
			const coordinatorTools = getCoordinatorTools();

			// Can read files
			expect(coordinatorTools).toContain("Read(**)");
			expect(coordinatorTools).toContain("Glob");
			expect(coordinatorTools).toContain("Grep");

			// Cannot edit files
			expect(coordinatorTools).not.toContain("Edit(**)");
			expect(coordinatorTools).not.toContain("Write");
			expect(coordinatorTools).not.toContain("NotebookEdit");

			// Can run commands (for tests, builds, git)
			expect(coordinatorTools).toContain("Bash");

			// Can delegate and track tasks
			expect(coordinatorTools).toContain("Task");
			expect(coordinatorTools).toContain("TaskCreate");

			// Can use Skills
			expect(coordinatorTools).toContain("Skill");
		});
	});

	describe("Type Safety", () => {
		it("should allow valid tool names in typed contexts", () => {
			// This is a compile-time check, but we can verify runtime behavior
			const validTool: ToolName = "Read(**)";
			expect(availableTools).toContain(validTool);
		});

		it("should have all tools as string type", () => {
			availableTools.forEach((tool) => {
				expect(typeof tool).toBe("string");
			});

			readOnlyTools.forEach((tool) => {
				expect(typeof tool).toBe("string");
			});

			writeTools.forEach((tool) => {
				expect(typeof tool).toBe("string");
			});
		});
	});

	describe("Tool Categorization Logic", () => {
		it("Read should be read-only", () => {
			expect(readOnlyTools).toContain("Read(**)");
			expect(writeTools).not.toContain("Read(**)");
		});

		it("Edit should be a write tool", () => {
			expect(writeTools).toContain("Edit(**)");
			expect(readOnlyTools).not.toContain("Edit(**)");
		});

		it("Write should be a write tool", () => {
			expect(writeTools).toContain("Write(**)");
			expect(readOnlyTools).not.toContain("Write(**)");
		});

		it("Bash should be a write tool (can modify system)", () => {
			expect(writeTools).toContain("Bash");
			expect(readOnlyTools).not.toContain("Bash");
		});

		it("Task should be read-only (delegates to other tools)", () => {
			expect(readOnlyTools).toContain("Task");
			expect(writeTools).not.toContain("Task");
		});

		it("WebFetch should be read-only", () => {
			expect(readOnlyTools).toContain("WebFetch");
			expect(writeTools).not.toContain("WebFetch");
		});

		it("WebSearch should be read-only", () => {
			expect(readOnlyTools).toContain("WebSearch");
			expect(writeTools).not.toContain("WebSearch");
		});

		it("Glob should be read-only", () => {
			expect(readOnlyTools).toContain("Glob");
			expect(writeTools).not.toContain("Glob");
		});

		it("Grep should be read-only", () => {
			expect(readOnlyTools).toContain("Grep");
			expect(writeTools).not.toContain("Grep");
		});

		it("Notebook tools should be categorized correctly", () => {
			expect(writeTools).toContain("NotebookEdit");
		});

		it("Skill should be read-only", () => {
			expect(readOnlyTools).toContain("Skill");
			expect(writeTools).not.toContain("Skill");
		});
	});
});
