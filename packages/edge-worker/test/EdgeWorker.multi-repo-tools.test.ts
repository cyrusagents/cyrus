import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_CYRUS_HOME } from "./test-dirs.js";

// Mock dependencies BEFORE imports
vi.mock("cyrus-claude-runner", () => ({
	ClaudeRunner: vi.fn(),
	getSafeTools: vi.fn(() => [
		"Read",
		"Edit",
		"Write",
		"Glob",
		"Grep",
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
	]),
	getReadOnlyTools: vi.fn(() => [
		"Read",
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
	]),
	getAllTools: vi.fn(() => [
		"Read",
		"Edit",
		"Write",
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
	]),
	getCoordinatorTools: vi.fn(() => [
		"Read",
		"Glob",
		"Grep",
		"Bash",
		"Task",
		"WebFetch",
		"WebSearch",
		"TaskCreate",
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
	]),
}));
vi.mock("@linear/sdk");
vi.mock("cyrus-linear-event-transport");
vi.mock("../src/SharedApplicationServer.js");
vi.mock("../src/AgentSessionManager.js");
vi.mock("fs/promises", () => ({
	readFile: vi.fn(),
	writeFile: vi.fn(),
	mkdir: vi.fn(),
	rename: vi.fn(),
}));

import { LinearClient } from "@linear/sdk";
import { getReadOnlyTools, getSafeTools } from "cyrus-claude-runner";
import { LinearEventTransport } from "cyrus-linear-event-transport";
import { AgentSessionManager } from "../src/AgentSessionManager.js";
import { EdgeWorker } from "../src/EdgeWorker.js";
import { SharedApplicationServer } from "../src/SharedApplicationServer.js";
import type { EdgeWorkerConfig, RepositoryConfig } from "../src/types.js";

describe("EdgeWorker - Multi-Repo Tool Authorization", () => {
	let edgeWorker: EdgeWorker;
	let mockConfig: EdgeWorkerConfig;
	let savedSlackBotToken: string | undefined;

	beforeEach(() => {
		vi.clearAllMocks();

		savedSlackBotToken = process.env.SLACK_BOT_TOKEN;
		delete process.env.SLACK_BOT_TOKEN;

		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});

		mockConfig = {
			proxyUrl: "http://localhost:3000",
			cyrusHome: TEST_CYRUS_HOME,
			defaultAllowedTools: ["Read", "Write", "Edit"],
			repositories: [
				{
					id: "repo-a",
					name: "Repo A",
					repositoryPath: "/test/repo-a",
					workspaceBaseDir: "/test/workspaces-a",
					baseBranch: "main",
					linearWorkspaceId: "test-workspace",
					isActive: true,
				},
				{
					id: "repo-b",
					name: "Repo B",
					repositoryPath: "/test/repo-b",
					workspaceBaseDir: "/test/workspaces-b",
					baseBranch: "main",
					linearWorkspaceId: "test-workspace",
					isActive: true,
				},
			],
			linearWorkspaces: {
				"test-workspace": { linearToken: "test-token" },
			},
		};

		vi.mocked(SharedApplicationServer).mockImplementation(
			() =>
				({
					start: vi.fn().mockResolvedValue(undefined),
					stop: vi.fn().mockResolvedValue(undefined),
					getFastifyInstance: vi.fn().mockReturnValue({ post: vi.fn() }),
					getWebhookUrl: vi
						.fn()
						.mockReturnValue("http://localhost:3456/webhook"),
					setWebhookHandler: vi.fn(),
					setOAuthCallbackHandler: vi.fn(),
				}) as any,
		);

		vi.mocked(AgentSessionManager).mockImplementation(
			() =>
				({
					addSession: vi.fn(),
					getSession: vi.fn(),
					removeSession: vi.fn(),
					getAllSessions: vi.fn().mockReturnValue([]),
					clearAllSessions: vi.fn(),
					on: vi.fn(),
				}) as any,
		);

		vi.mocked(LinearEventTransport).mockImplementation(
			() =>
				({
					register: vi.fn(),
					on: vi.fn(),
					removeAllListeners: vi.fn(),
				}) as any,
		);

		vi.mocked(LinearClient).mockImplementation(
			() =>
				({
					viewer: vi
						.fn()
						.mockResolvedValue({ id: "test-user", email: "test@example.com" }),
					issue: vi.fn(),
					comment: vi.fn(),
					createComment: vi.fn(),
					webhook: vi.fn(),
					webhooks: vi.fn(),
					createWebhook: vi.fn(),
					updateWebhook: vi.fn(),
					deleteWebhook: vi.fn(),
					user: vi.fn(),
				}) as any,
		);

		edgeWorker = new EdgeWorker(mockConfig);
	});

	afterEach(() => {
		vi.restoreAllMocks();

		if (savedSlackBotToken === undefined) {
			delete process.env.SLACK_BOT_TOKEN;
		} else {
			process.env.SLACK_BOT_TOKEN = savedSlackBotToken;
		}
	});

	describe("buildAllowedTools - multi-repo union", () => {
		const getBuildAllowedTools = (ew: EdgeWorker) =>
			(ew as any).buildAllowedTools.bind(ew);

		it("should union allowed tools across multiple repositories", () => {
			const repoA: RepositoryConfig = {
				...mockConfig.repositories[0],
				allowedTools: ["Read", "Write"],
			};
			const repoB: RepositoryConfig = {
				...mockConfig.repositories[1],
				allowedTools: ["Read", "Bash", "Edit"],
			};

			const buildAllowedTools = getBuildAllowedTools(edgeWorker);
			const tools = buildAllowedTools([repoA, repoB]);

			// Union of [Read, Write] and [Read, Bash, Edit] + MCP tools
			expect(tools).toEqual([
				"Read",
				"Write",
				"Bash",
				"Edit",
				"mcp__linear",
				"mcp__cyrus-tools",
				"mcp__cyrus-docs",
			]);
		});

		it("should resolve presets before unioning", () => {
			const repoA: RepositoryConfig = {
				...mockConfig.repositories[0],
				labelPrompts: {
					debugger: {
						labels: ["bug"],
						allowedTools: "readOnly",
					},
				},
			};
			const repoB: RepositoryConfig = {
				...mockConfig.repositories[1],
				allowedTools: ["Read", "Bash", "Edit"],
			};

			const buildAllowedTools = getBuildAllowedTools(edgeWorker);
			const tools = buildAllowedTools([repoA, repoB], "debugger");

			// Repo A: readOnly preset, Repo B: custom tools → union
			const readOnlyTools = getReadOnlyTools();
			const expectedUnion = [
				...new Set([...readOnlyTools, "Read", "Bash", "Edit"]),
			];
			expect(tools).toEqual([
				...expectedUnion,
				"mcp__linear",
				"mcp__cyrus-tools",
				"mcp__cyrus-docs",
			]);
		});

		it("should add workspace MCP tools once regardless of repo count", () => {
			const repoA: RepositoryConfig = {
				...mockConfig.repositories[0],
				allowedTools: ["Read"],
			};
			const repoB: RepositoryConfig = {
				...mockConfig.repositories[1],
				allowedTools: ["Write"],
			};

			const buildAllowedTools = getBuildAllowedTools(edgeWorker);
			const tools = buildAllowedTools([repoA, repoB]);

			// MCP tools appear exactly once
			expect(tools.filter((t) => t === "mcp__linear")).toHaveLength(1);
			expect(tools.filter((t) => t === "mcp__cyrus-tools")).toHaveLength(1);
			expect(tools.filter((t) => t === "mcp__cyrus-docs")).toHaveLength(1);
		});

		it("should include Slack MCP when SLACK_BOT_TOKEN is set for multi-repo", () => {
			process.env.SLACK_BOT_TOKEN = "xoxb-test-token";

			const repoA: RepositoryConfig = {
				...mockConfig.repositories[0],
				allowedTools: ["Read"],
			};
			const repoB: RepositoryConfig = {
				...mockConfig.repositories[1],
				allowedTools: ["Write"],
			};

			const buildAllowedTools = getBuildAllowedTools(edgeWorker);
			const tools = buildAllowedTools([repoA, repoB]);

			expect(tools).toContain("mcp__slack");
			expect(tools.filter((t) => t === "mcp__slack")).toHaveLength(1);
		});

		it("should handle empty repository array with global defaults", () => {
			const buildAllowedTools = getBuildAllowedTools(edgeWorker);
			const tools = buildAllowedTools([]);

			// Should fall back to global defaultAllowedTools + MCP
			expect(tools).toEqual([
				"Read",
				"Write",
				"Edit",
				"mcp__linear",
				"mcp__cyrus-tools",
				"mcp__cyrus-docs",
			]);
		});

		it("should fall back to safe tools for empty array when no global defaults", () => {
			const configNoDefaults: EdgeWorkerConfig = {
				...mockConfig,
				defaultAllowedTools: undefined,
			};
			const ew = new EdgeWorker(configNoDefaults);
			const buildAllowedTools = getBuildAllowedTools(ew);
			const tools = buildAllowedTools([]);

			expect(tools).toEqual([
				...getSafeTools(),
				"mcp__linear",
				"mcp__cyrus-tools",
				"mcp__cyrus-docs",
			]);
		});

		it("should still work with a single repository (backwards compatible)", () => {
			const repository: RepositoryConfig = {
				...mockConfig.repositories[0],
				allowedTools: ["Read", "Write"],
			};

			const buildAllowedTools = getBuildAllowedTools(edgeWorker);
			const tools = buildAllowedTools(repository);

			expect(tools).toEqual([
				"Read",
				"Write",
				"mcp__linear",
				"mcp__cyrus-tools",
				"mcp__cyrus-docs",
			]);
		});

		it("should union tools from 3 repositories", () => {
			const repoA: RepositoryConfig = {
				...mockConfig.repositories[0],
				id: "repo-a",
				name: "Repo A",
				allowedTools: ["Read"],
			};
			const repoB: RepositoryConfig = {
				...mockConfig.repositories[1],
				id: "repo-b",
				name: "Repo B",
				allowedTools: ["Write"],
			};
			const repoC: RepositoryConfig = {
				...mockConfig.repositories[0],
				id: "repo-c",
				name: "Repo C",
				allowedTools: ["Bash"],
			};

			const buildAllowedTools = getBuildAllowedTools(edgeWorker);
			const tools = buildAllowedTools([repoA, repoB, repoC]);

			expect(tools).toEqual([
				"Read",
				"Write",
				"Bash",
				"mcp__linear",
				"mcp__cyrus-tools",
				"mcp__cyrus-docs",
			]);
		});
	});

	describe("buildDisallowedTools - multi-repo intersection", () => {
		const getBuildDisallowedTools = (ew: EdgeWorker) =>
			(ew as any).buildDisallowedTools.bind(ew);

		it("should intersect disallowed tools across multiple repositories", () => {
			const repoA: RepositoryConfig = {
				...mockConfig.repositories[0],
				disallowedTools: ["Bash", "Write", "SystemAccess"],
			};
			const repoB: RepositoryConfig = {
				...mockConfig.repositories[1],
				disallowedTools: ["Bash", "Edit", "SystemAccess"],
			};

			const buildDisallowedTools = getBuildDisallowedTools(edgeWorker);
			const tools = buildDisallowedTools([repoA, repoB]);

			// Intersection: only Bash and SystemAccess are in both
			expect(tools).toEqual(expect.arrayContaining(["Bash", "SystemAccess"]));
			expect(tools).toHaveLength(2);
			expect(tools).not.toContain("Write");
			expect(tools).not.toContain("Edit");
		});

		it("should return empty when no tools are in all repos' disallowed lists", () => {
			const repoA: RepositoryConfig = {
				...mockConfig.repositories[0],
				disallowedTools: ["Bash", "Write"],
			};
			const repoB: RepositoryConfig = {
				...mockConfig.repositories[1],
				disallowedTools: ["Edit", "SystemAccess"],
			};

			const buildDisallowedTools = getBuildDisallowedTools(edgeWorker);
			const tools = buildDisallowedTools([repoA, repoB]);

			// No overlap
			expect(tools).toEqual([]);
		});

		it("should return all tools when all repos have the same disallowed list", () => {
			const repoA: RepositoryConfig = {
				...mockConfig.repositories[0],
				disallowedTools: ["Bash", "SystemAccess"],
			};
			const repoB: RepositoryConfig = {
				...mockConfig.repositories[1],
				disallowedTools: ["Bash", "SystemAccess"],
			};

			const buildDisallowedTools = getBuildDisallowedTools(edgeWorker);
			const tools = buildDisallowedTools([repoA, repoB]);

			expect(tools).toEqual(expect.arrayContaining(["Bash", "SystemAccess"]));
			expect(tools).toHaveLength(2);
		});

		it("should handle one repo with empty disallowed tools (intersection = empty)", () => {
			const repoA: RepositoryConfig = {
				...mockConfig.repositories[0],
				disallowedTools: ["Bash", "Write"],
			};
			const repoB: RepositoryConfig = {
				...mockConfig.repositories[1],
				// No disallowedTools → resolves to []
			};

			const buildDisallowedTools = getBuildDisallowedTools(edgeWorker);
			const tools = buildDisallowedTools([repoA, repoB]);

			// Intersection with empty = empty
			expect(tools).toEqual([]);
		});

		it("should handle empty repository array with global defaults", () => {
			const configWithDefaults: EdgeWorkerConfig = {
				...mockConfig,
				defaultDisallowedTools: ["Bash", "DangerousTool"],
			};
			const ew = new EdgeWorker(configWithDefaults);
			const buildDisallowedTools = getBuildDisallowedTools(ew);
			const tools = buildDisallowedTools([]);

			expect(tools).toEqual(["Bash", "DangerousTool"]);
		});

		it("should still work with a single repository (backwards compatible)", () => {
			const repository: RepositoryConfig = {
				...mockConfig.repositories[0],
				disallowedTools: ["Bash", "Write"],
			};

			const buildDisallowedTools = getBuildDisallowedTools(edgeWorker);
			const tools = buildDisallowedTools(repository);

			expect(tools).toEqual(["Bash", "Write"]);
		});

		it("should intersect across 3 repositories", () => {
			const repoA: RepositoryConfig = {
				...mockConfig.repositories[0],
				id: "repo-a",
				name: "Repo A",
				disallowedTools: ["Bash", "Write", "SystemAccess"],
			};
			const repoB: RepositoryConfig = {
				...mockConfig.repositories[1],
				id: "repo-b",
				name: "Repo B",
				disallowedTools: ["Bash", "Edit", "SystemAccess"],
			};
			const repoC: RepositoryConfig = {
				...mockConfig.repositories[0],
				id: "repo-c",
				name: "Repo C",
				disallowedTools: ["Bash", "Delete", "SystemAccess"],
			};

			const buildDisallowedTools = getBuildDisallowedTools(edgeWorker);
			const tools = buildDisallowedTools([repoA, repoB, repoC]);

			// Only Bash and SystemAccess are in ALL three
			expect(tools).toEqual(expect.arrayContaining(["Bash", "SystemAccess"]));
			expect(tools).toHaveLength(2);
		});

		it("should use prompt-type config for intersection across repos", () => {
			const repoA: RepositoryConfig = {
				...mockConfig.repositories[0],
				labelPrompts: {
					debugger: {
						labels: ["bug"],
						allowedTools: "readOnly",
						disallowedTools: ["Bash", "Write", "DangerousTool"],
					},
				},
			};
			const repoB: RepositoryConfig = {
				...mockConfig.repositories[1],
				labelPrompts: {
					debugger: {
						labels: ["bug"],
						allowedTools: "readOnly",
						disallowedTools: ["Bash", "Edit", "DangerousTool"],
					},
				},
			};

			const buildDisallowedTools = getBuildDisallowedTools(edgeWorker);
			const tools = buildDisallowedTools([repoA, repoB], "debugger");

			// Intersection: Bash and DangerousTool
			expect(tools).toEqual(expect.arrayContaining(["Bash", "DangerousTool"]));
			expect(tools).toHaveLength(2);
		});
	});

	describe("buildMergedMcpConfigPath - multi-repo MCP path merging", () => {
		const getBuildMergedMcpConfigPath = (ew: EdgeWorker) =>
			(ew as any).mcpConfigService.buildMergedMcpConfigPath.bind(
				(ew as any).mcpConfigService,
			);

		it("should return single repo mcpConfigPath unchanged", () => {
			const repository: RepositoryConfig = {
				...mockConfig.repositories[0],
				mcpConfigPath: "/path/to/.mcp.json",
			};

			const buildMergedMcpConfigPath = getBuildMergedMcpConfigPath(edgeWorker);
			const result = buildMergedMcpConfigPath(repository);

			expect(result).toBe("/path/to/.mcp.json");
		});

		it("should return single repo array mcpConfigPath unchanged", () => {
			const repository: RepositoryConfig = {
				...mockConfig.repositories[0],
				mcpConfigPath: ["/path/a/.mcp.json", "/path/b/.mcp.json"],
			};

			const buildMergedMcpConfigPath = getBuildMergedMcpConfigPath(edgeWorker);
			const result = buildMergedMcpConfigPath(repository);

			expect(result).toEqual(["/path/a/.mcp.json", "/path/b/.mcp.json"]);
		});

		it("should merge mcpConfigPath from multiple repos into one list", () => {
			const repoA: RepositoryConfig = {
				...mockConfig.repositories[0],
				mcpConfigPath: "/repo-a/.mcp.json",
			};
			const repoB: RepositoryConfig = {
				...mockConfig.repositories[1],
				mcpConfigPath: "/repo-b/.mcp.json",
			};

			const buildMergedMcpConfigPath = getBuildMergedMcpConfigPath(edgeWorker);
			const result = buildMergedMcpConfigPath([repoA, repoB]);

			expect(result).toEqual(["/repo-a/.mcp.json", "/repo-b/.mcp.json"]);
		});

		it("should handle mixed string and array mcpConfigPaths", () => {
			const repoA: RepositoryConfig = {
				...mockConfig.repositories[0],
				mcpConfigPath: "/repo-a/.mcp.json",
			};
			const repoB: RepositoryConfig = {
				...mockConfig.repositories[1],
				mcpConfigPath: ["/repo-b/.mcp.json", "/repo-b/extra.json"],
			};

			const buildMergedMcpConfigPath = getBuildMergedMcpConfigPath(edgeWorker);
			const result = buildMergedMcpConfigPath([repoA, repoB]);

			expect(result).toEqual([
				"/repo-a/.mcp.json",
				"/repo-b/.mcp.json",
				"/repo-b/extra.json",
			]);
		});

		it("should return undefined when no repos have mcpConfigPath", () => {
			const repoA: RepositoryConfig = {
				...mockConfig.repositories[0],
			};
			const repoB: RepositoryConfig = {
				...mockConfig.repositories[1],
			};

			const buildMergedMcpConfigPath = getBuildMergedMcpConfigPath(edgeWorker);
			const result = buildMergedMcpConfigPath([repoA, repoB]);

			expect(result).toBeUndefined();
		});

		it("should skip repos without mcpConfigPath", () => {
			const repoA: RepositoryConfig = {
				...mockConfig.repositories[0],
				mcpConfigPath: "/repo-a/.mcp.json",
			};
			const repoB: RepositoryConfig = {
				...mockConfig.repositories[1],
				// no mcpConfigPath
			};

			const buildMergedMcpConfigPath = getBuildMergedMcpConfigPath(edgeWorker);
			const result = buildMergedMcpConfigPath([repoA, repoB]);

			// Single path from one repo
			expect(result).toBe("/repo-a/.mcp.json");
		});
	});
});
