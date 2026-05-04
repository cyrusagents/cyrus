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

import { readFile } from "node:fs/promises";
import { LinearClient } from "@linear/sdk";
import {
	getAllTools,
	getReadOnlyTools,
	getSafeTools,
} from "cyrus-claude-runner";
import { LinearEventTransport } from "cyrus-linear-event-transport";
import { AgentSessionManager } from "../src/AgentSessionManager.js";
import { EdgeWorker } from "../src/EdgeWorker.js";
import { SharedApplicationServer } from "../src/SharedApplicationServer.js";
import type { EdgeWorkerConfig, RepositoryConfig } from "../src/types.js";

describe("EdgeWorker - Dynamic Tools Configuration", () => {
	let edgeWorker: EdgeWorker;
	let mockConfig: EdgeWorkerConfig;
	let savedSlackBotToken: string | undefined;

	beforeEach(() => {
		vi.clearAllMocks();

		// Save and clear SLACK_BOT_TOKEN to ensure deterministic tool lists
		savedSlackBotToken = process.env.SLACK_BOT_TOKEN;
		delete process.env.SLACK_BOT_TOKEN;

		// Mock console methods
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});

		// Create mock configuration
		mockConfig = {
			proxyUrl: "http://localhost:3000",
			cyrusHome: TEST_CYRUS_HOME,
			defaultAllowedTools: ["Read", "Write", "Edit"],
			repositories: [
				{
					id: "test-repo",
					name: "Test Repo",
					repositoryPath: "/test/repo",
					workspaceBaseDir: "/test/workspaces",
					baseBranch: "main",
					linearWorkspaceId: "test-workspace",
					isActive: true,
				},
			],
			linearWorkspaces: {
				"test-workspace": { linearToken: "test-token" },
			},
		};

		// Mock SharedApplicationServer
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

		// Mock AgentSessionManager
		vi.mocked(AgentSessionManager).mockImplementation(
			() =>
				({
					addSession: vi.fn(),
					getSession: vi.fn(),
					removeSession: vi.fn(),
					getAllSessions: vi.fn().mockReturnValue([]),
					clearAllSessions: vi.fn(),
					on: vi.fn(), // EventEmitter method
				}) as any,
		);

		// Mock LinearEventTransport
		vi.mocked(LinearEventTransport).mockImplementation(
			() =>
				({
					register: vi.fn(),
					on: vi.fn(),
					removeAllListeners: vi.fn(),
				}) as any,
		);

		// Mock LinearClient
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

		// Restore SLACK_BOT_TOKEN
		if (savedSlackBotToken === undefined) {
			delete process.env.SLACK_BOT_TOKEN;
		} else {
			process.env.SLACK_BOT_TOKEN = savedSlackBotToken;
		}
	});

	describe("buildAllowedTools", () => {
		// Access private method for testing
		const getBuildAllowedTools = (ew: EdgeWorker) =>
			(ew as any).buildAllowedTools.bind(ew);

		it("should use repository-specific prompt type configuration when available", () => {
			const repository: RepositoryConfig = {
				...mockConfig.repositories[0],
				labelPrompts: {
					debugger: {
						labels: ["bug", "error"],
						allowedTools: "readOnly",
					},
					builder: {
						labels: ["feature"],
						allowedTools: ["Read", "Edit", "Task"],
					},
					scoper: {
						labels: ["prd"],
						allowedTools: "safe",
					},
				},
			};

			const buildAllowedTools = getBuildAllowedTools(edgeWorker);

			// Test debugger prompt with readOnly preset
			const debuggerTools = buildAllowedTools(repository, "debugger");
			expect(debuggerTools).toEqual([
				...getReadOnlyTools(),
				"mcp__linear",
				"mcp__cyrus-tools",
				"mcp__cyrus-docs",
			]);

			// Test builder prompt with custom array
			const builderTools = buildAllowedTools(repository, "builder");
			expect(builderTools).toEqual([
				"Read",
				"Edit",
				"Task",
				"mcp__linear",
				"mcp__cyrus-tools",
				"mcp__cyrus-docs",
			]);

			// Test scoper prompt with safe preset
			const scoperTools = buildAllowedTools(repository, "scoper");
			expect(scoperTools).toEqual([
				...getSafeTools(),
				"mcp__linear",
				"mcp__cyrus-tools",
				"mcp__cyrus-docs",
			]);
		});

		it("should use global prompt defaults when repository-specific config is not available", () => {
			const configWithDefaults: EdgeWorkerConfig = {
				...mockConfig,
				promptDefaults: {
					debugger: {
						allowedTools: "all",
					},
					builder: {
						allowedTools: "safe",
					},
					scoper: {
						allowedTools: ["Read", "WebFetch"],
					},
				},
			};

			const edgeWorkerWithDefaults = new EdgeWorker(configWithDefaults);
			const buildAllowedTools = getBuildAllowedTools(edgeWorkerWithDefaults);

			const repository: RepositoryConfig = {
				...mockConfig.repositories[0],
			};

			// Test debugger prompt with global all preset
			const debuggerTools = buildAllowedTools(repository, "debugger");
			expect(debuggerTools).toEqual([
				...getAllTools(),
				"mcp__linear",
				"mcp__cyrus-tools",
				"mcp__cyrus-docs",
			]);

			// Test builder prompt with global safe preset
			const builderTools = buildAllowedTools(repository, "builder");
			expect(builderTools).toEqual([
				...getSafeTools(),
				"mcp__linear",
				"mcp__cyrus-tools",
				"mcp__cyrus-docs",
			]);

			// Test scoper prompt with global custom array
			const scoperTools = buildAllowedTools(repository, "scoper");
			expect(scoperTools).toEqual([
				"Read",
				"WebFetch",
				"mcp__linear",
				"mcp__cyrus-tools",
				"mcp__cyrus-docs",
			]);
		});

		it("should fall back to repository-level allowed tools when no prompt type is specified", () => {
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

		it("should fall back to global default allowed tools when no other config is available", () => {
			const repository: RepositoryConfig = {
				...mockConfig.repositories[0],
			};

			const buildAllowedTools = getBuildAllowedTools(edgeWorker);
			const tools = buildAllowedTools(repository);

			// Should use global defaultAllowedTools from mockConfig
			expect(tools).toEqual([
				"Read",
				"Write",
				"Edit",
				"mcp__linear",
				"mcp__cyrus-tools",
				"mcp__cyrus-docs",
			]);
		});

		it("should fall back to safe tools when no configuration is provided", () => {
			const configWithoutDefaults: EdgeWorkerConfig = {
				...mockConfig,
				defaultAllowedTools: undefined,
			};

			const edgeWorkerNoDefaults = new EdgeWorker(configWithoutDefaults);
			const buildAllowedTools = getBuildAllowedTools(edgeWorkerNoDefaults);

			const repository: RepositoryConfig = {
				...mockConfig.repositories[0],
			};

			const tools = buildAllowedTools(repository);
			expect(tools).toEqual([
				...getSafeTools(),
				"mcp__linear",
				"mcp__cyrus-tools",
				"mcp__cyrus-docs",
			]);
		});

		it("should always include Linear MCP tools", () => {
			const repository: RepositoryConfig = {
				...mockConfig.repositories[0],
				allowedTools: ["Read", "mcp__linear"], // Already includes Linear MCP
			};

			const buildAllowedTools = getBuildAllowedTools(edgeWorker);
			const tools = buildAllowedTools(repository);

			// Should deduplicate Linear MCP tools
			expect(tools).toEqual([
				"Read",
				"mcp__linear",
				"mcp__cyrus-tools",
				"mcp__cyrus-docs",
			]);
			expect(tools.filter((t) => t === "mcp__linear")).toHaveLength(1);
		});

		it("should include Slack MCP tools when SLACK_BOT_TOKEN is set", () => {
			const originalSlackToken = process.env.SLACK_BOT_TOKEN;
			try {
				process.env.SLACK_BOT_TOKEN = "xoxb-test-slack-token";

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
					"mcp__slack",
				]);
			} finally {
				if (originalSlackToken === undefined) {
					delete process.env.SLACK_BOT_TOKEN;
				} else {
					process.env.SLACK_BOT_TOKEN = originalSlackToken;
				}
			}
		});

		it("should not include Slack MCP tools when SLACK_BOT_TOKEN is not set", () => {
			const originalSlackToken = process.env.SLACK_BOT_TOKEN;
			try {
				delete process.env.SLACK_BOT_TOKEN;

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
				expect(tools).not.toContain("mcp__slack");
			} finally {
				if (originalSlackToken === undefined) {
					delete process.env.SLACK_BOT_TOKEN;
				} else {
					process.env.SLACK_BOT_TOKEN = originalSlackToken;
				}
			}
		});

		it("should handle backward compatibility with old array-based labelPrompts", () => {
			const repository: RepositoryConfig = {
				...mockConfig.repositories[0],
				labelPrompts: {
					debugger: ["bug", "error"] as any, // Old format
					builder: {
						labels: ["feature"],
						allowedTools: "safe",
					},
				} as any,
			};

			const buildAllowedTools = getBuildAllowedTools(edgeWorker);

			// Old format should fall back to repository/global defaults
			const debuggerTools = buildAllowedTools(repository, "debugger");
			expect(debuggerTools).toEqual([
				"Read",
				"Write",
				"Edit",
				"mcp__linear",
				"mcp__cyrus-tools",
				"mcp__cyrus-docs",
			]);

			// New format should work as expected
			const builderTools = buildAllowedTools(repository, "builder");
			expect(builderTools).toEqual([
				...getSafeTools(),
				"mcp__linear",
				"mcp__cyrus-tools",
				"mcp__cyrus-docs",
			]);
		});

		it("should handle single tool string in resolveToolPreset", () => {
			const repository: RepositoryConfig = {
				...mockConfig.repositories[0],
				labelPrompts: {
					debugger: {
						labels: ["bug"],
						allowedTools: "CustomTool" as any, // Single non-preset string
					},
				},
			};

			const buildAllowedTools = getBuildAllowedTools(edgeWorker);
			const tools = buildAllowedTools(repository, "debugger");

			expect(tools).toEqual([
				"CustomTool",
				"mcp__linear",
				"mcp__cyrus-tools",
				"mcp__cyrus-docs",
			]);
		});
	});

	describe("determineSystemPromptFromLabels", () => {
		// Access private method for testing
		const getDetermineSystemPromptFromLabels = (ew: EdgeWorker) =>
			(ew as any).determineSystemPromptFromLabels.bind(ew);

		beforeEach(() => {
			// Mock file system for prompt templates
			vi.mocked(readFile).mockImplementation(async (path: string) => {
				if (path.includes("debugger.md")) {
					return 'Debugger prompt content\n<version-tag value="debugger-v1.0.0" />';
				}
				if (path.includes("builder.md")) {
					return 'Builder prompt content\n<version-tag value="builder-v2.0.0" />';
				}
				if (path.includes("scoper.md")) {
					return "Scoper prompt content";
				}
				if (path.includes("orchestrator.md")) {
					return 'You are a masterful software engineering orchestrator\n<version-tag value="orchestrator-v1.0.0" />';
				}
				throw new Error(`File not found: ${path}`);
			});
		});

		it("should return prompt with type for matching labels", async () => {
			const repository: RepositoryConfig = {
				...mockConfig.repositories[0],
				labelPrompts: {
					debugger: {
						labels: ["bug", "error"],
						allowedTools: "readOnly",
					},
					builder: {
						labels: ["feature"],
						allowedTools: "safe",
					},
				},
			};

			const determineSystemPromptFromLabels =
				getDetermineSystemPromptFromLabels(edgeWorker);

			// Test debugger prompt
			const debuggerResult = await determineSystemPromptFromLabels(
				["bug", "unrelated"],
				repository,
			);
			expect(debuggerResult).toEqual({
				prompt:
					'Debugger prompt content\n<version-tag value="debugger-v1.0.0" />',
				version: "debugger-v1.0.0",
				type: "debugger",
			});

			// Test builder prompt
			const builderResult = await determineSystemPromptFromLabels(
				["feature", "enhancement"],
				repository,
			);
			expect(builderResult).toEqual({
				prompt:
					'Builder prompt content\n<version-tag value="builder-v2.0.0" />',
				version: "builder-v2.0.0",
				type: "builder",
			});
		});

		it("should handle backward compatibility with old array format", async () => {
			const repository: RepositoryConfig = {
				...mockConfig.repositories[0],
				labelPrompts: {
					debugger: ["bug", "error"] as any, // Old format
					builder: {
						labels: ["feature"],
						allowedTools: "safe",
					},
				} as any,
			};

			const determineSystemPromptFromLabels =
				getDetermineSystemPromptFromLabels(edgeWorker);

			// Old format should still work for prompt selection
			const result = await determineSystemPromptFromLabels(["bug"], repository);
			expect(result).toEqual({
				prompt: expect.stringContaining("Debugger prompt content"),
				version: "debugger-v1.0.0",
				type: "debugger",
			});
		});

		it("should return undefined when no labels match", async () => {
			const repository: RepositoryConfig = {
				...mockConfig.repositories[0],
				labelPrompts: {
					debugger: {
						labels: ["bug"],
						allowedTools: "readOnly",
					},
				},
			};

			const determineSystemPromptFromLabels =
				getDetermineSystemPromptFromLabels(edgeWorker);
			const result = await determineSystemPromptFromLabels(
				["feature", "enhancement"],
				repository,
			);

			expect(result).toBeUndefined();
		});

		it("should return undefined when labelPrompts is not configured", async () => {
			const repository: RepositoryConfig = {
				...mockConfig.repositories[0],
			};

			const determineSystemPromptFromLabels =
				getDetermineSystemPromptFromLabels(edgeWorker);
			const result = await determineSystemPromptFromLabels(["bug"], repository);

			expect(result).toBeUndefined();
		});

		it("should return undefined when labels array is empty", async () => {
			const repository: RepositoryConfig = {
				...mockConfig.repositories[0],
				labelPrompts: {
					debugger: {
						labels: ["bug"],
						allowedTools: "readOnly",
					},
				},
			};

			const determineSystemPromptFromLabels =
				getDetermineSystemPromptFromLabels(edgeWorker);
			const result = await determineSystemPromptFromLabels([], repository);

			expect(result).toBeUndefined();
		});

		it("should select orchestrator prompt for Orchestrator label with coordinator tools preset", async () => {
			const repository: RepositoryConfig = {
				...mockConfig.repositories[0],
				labelPrompts: {
					orchestrator: {
						labels: ["Orchestrator"],
						allowedTools: "coordinator",
					},
				},
			};

			const determineSystemPromptFromLabels =
				getDetermineSystemPromptFromLabels(edgeWorker);
			const result = await determineSystemPromptFromLabels(
				["Orchestrator", "other-label"],
				repository,
			);

			expect(result).toBeDefined();
			expect(result?.type).toBe("orchestrator");
			expect(result?.prompt).toContain("orchestrator-v1.0.0");
			expect(result?.prompt).toContain(
				"masterful software engineering orchestrator",
			);
			expect(result?.version).toBe("orchestrator-v1.0.0");
		});
	});

	describe("buildDisallowedTools", () => {
		// Access private method for testing
		const getBuildDisallowedTools = (ew: EdgeWorker) =>
			(ew as any).buildDisallowedTools.bind(ew);

		it("should use repository-specific prompt type configuration when available", () => {
			const repository: RepositoryConfig = {
				...mockConfig.repositories[0],
				labelPrompts: {
					debugger: {
						labels: ["bug", "error"],
						allowedTools: "readOnly",
						disallowedTools: ["Bash", "Write"],
					},
				},
			};

			const buildDisallowedTools = getBuildDisallowedTools(edgeWorker);
			const tools = buildDisallowedTools(repository, "debugger");

			expect(tools).toEqual(["Bash", "Write"]);
		});

		it("should use global prompt defaults when repository-specific config is not available", () => {
			const repository: RepositoryConfig = {
				...mockConfig.repositories[0],
			};

			// Add global prompt defaults for disallowed tools
			const configWithPromptDefaults: EdgeWorkerConfig = {
				...mockConfig,
				promptDefaults: {
					debugger: {
						disallowedTools: ["Bash", "SystemAccess"],
					},
				},
			};
			const ew = new EdgeWorker(configWithPromptDefaults);

			const buildDisallowedTools = getBuildDisallowedTools(ew);
			const tools = buildDisallowedTools(repository, "debugger");

			expect(tools).toEqual(["Bash", "SystemAccess"]);
		});

		it("should fall back to repository-level disallowed tools when no prompt type is specified", () => {
			const repository: RepositoryConfig = {
				...mockConfig.repositories[0],
				disallowedTools: ["WebFetch", "WebSearch"],
			};

			const buildDisallowedTools = getBuildDisallowedTools(edgeWorker);
			const tools = buildDisallowedTools(repository);

			expect(tools).toEqual(["WebFetch", "WebSearch"]);
		});

		it("should fall back to global default disallowed tools when no other config is available", () => {
			const repository: RepositoryConfig = {
				...mockConfig.repositories[0],
			};

			// Add global default disallowed tools
			const configWithDefaults: EdgeWorkerConfig = {
				...mockConfig,
				defaultDisallowedTools: ["Bash", "DangerousTool"],
			};
			const ew = new EdgeWorker(configWithDefaults);

			const buildDisallowedTools = getBuildDisallowedTools(ew);
			const tools = buildDisallowedTools(repository);

			expect(tools).toEqual(["Bash", "DangerousTool"]);
		});

		it("should return empty array when no configuration is provided (no defaults)", () => {
			const repository: RepositoryConfig = {
				...mockConfig.repositories[0],
			};

			const buildDisallowedTools = getBuildDisallowedTools(edgeWorker);
			const tools = buildDisallowedTools(repository);

			// Unlike allowedTools, disallowedTools has no defaults
			expect(tools).toEqual([]);
		});

		it("should handle prompt type with repository-level fallback", () => {
			const repository: RepositoryConfig = {
				...mockConfig.repositories[0],
				disallowedTools: ["Bash"],
				labelPrompts: {
					builder: {
						labels: ["feature"],
						allowedTools: "safe",
						// No disallowedTools for builder
					},
				},
			};

			const buildDisallowedTools = getBuildDisallowedTools(edgeWorker);
			const tools = buildDisallowedTools(repository, "builder");

			// Should fall back to repository-level disallowedTools
			expect(tools).toEqual(["Bash"]);
		});

		it("should handle backward compatibility with old array-based labelPrompts", () => {
			const repository: RepositoryConfig = {
				...mockConfig.repositories[0],
				disallowedTools: ["OldDefault"],
				labelPrompts: {
					debugger: ["bug", "error"] as any, // Old format
					builder: {
						labels: ["feature"],
						allowedTools: "safe",
						disallowedTools: ["NewFormat"],
					},
				} as any,
			};

			const buildDisallowedTools = getBuildDisallowedTools(edgeWorker);

			// Old format should fall back to repository defaults
			const debuggerTools = buildDisallowedTools(repository, "debugger");
			expect(debuggerTools).toEqual(["OldDefault"]);

			// New format should work as expected
			const builderTools = buildDisallowedTools(repository, "builder");
			expect(builderTools).toEqual(["NewFormat"]);
		});

		it("should respect priority hierarchy", () => {
			const repository: RepositoryConfig = {
				...mockConfig.repositories[0],
				disallowedTools: ["RepoLevel"],
				labelPrompts: {
					debugger: {
						labels: ["bug"],
						allowedTools: "all",
						disallowedTools: ["LabelLevel"],
					},
				},
			};

			const configWithAllLevels: EdgeWorkerConfig = {
				...mockConfig,
				defaultDisallowedTools: ["GlobalLevel"],
				promptDefaults: {
					debugger: {
						disallowedTools: ["PromptDefault"],
					},
				},
			};
			const ew = new EdgeWorker(configWithAllLevels);

			const buildDisallowedTools = getBuildDisallowedTools(ew);

			// Should use label-level config (highest priority)
			const tools = buildDisallowedTools(repository, "debugger");
			expect(tools).toEqual(["LabelLevel"]);

			// Without prompt type, should use repository level
			const noPromptTools = buildDisallowedTools(repository);
			expect(noPromptTools).toEqual(["RepoLevel"]);
		});
	});
});
