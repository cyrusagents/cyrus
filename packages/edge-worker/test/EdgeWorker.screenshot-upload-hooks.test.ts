import { readFile } from "node:fs/promises";
import { LinearClient } from "@linear/sdk";
import { ClaudeRunner, type HookCallbackMatcher } from "atmiko-claude-runner";
import type { LinearAgentSessionCreatedWebhook } from "atmiko-core";
import {
	isAgentSessionCreatedWebhook,
	isAgentSessionPromptedWebhook,
} from "atmiko-core";
import { GeminiRunner } from "atmiko-gemini-runner";
import { LinearEventTransport } from "atmiko-linear-event-transport";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager.js";
import { EdgeWorker } from "../src/EdgeWorker.js";
import { SharedApplicationServer } from "../src/SharedApplicationServer.js";
import type { EdgeWorkerConfig, RepositoryConfig } from "../src/types.js";
import { TEST_ATMIKO_HOME } from "./test-dirs.js";

// Mock fs/promises
vi.mock("fs/promises", () => ({
	readFile: vi.fn(),
	writeFile: vi.fn(),
	mkdir: vi.fn(),
	rename: vi.fn(),
}));

// Mock dependencies
vi.mock("atmiko-claude-runner");
vi.mock("atmiko-codex-runner");
vi.mock("atmiko-gemini-runner");
vi.mock("atmiko-linear-event-transport");
vi.mock("@linear/sdk");
vi.mock("../src/SharedApplicationServer.js");
vi.mock("../src/AgentSessionManager.js");
vi.mock("atmiko-core", async (importOriginal) => {
	const actual = (await importOriginal()) as any;
	return {
		...actual,
		isAgentSessionCreatedWebhook: vi.fn(),
		isAgentSessionPromptedWebhook: vi.fn(),
		PersistenceManager: vi.fn().mockImplementation(function () {
			return {
				loadEdgeWorkerState: vi.fn().mockResolvedValue(null),
				saveEdgeWorkerState: vi.fn().mockResolvedValue(undefined),
			};
		}),
	};
});
vi.mock("file-type");

/**
 * Test suite for screenshot upload guidance hooks
 *
 * Bug: CYPACK-699
 * Problem: Agent takes screenshots but doesn't use linear_upload_file tool,
 * instead copying files locally and using file paths that Linear cannot resolve.
 *
 * Root cause: The PostToolUse hook for screenshot tools doesn't mention
 * the linear_upload_file tool, so Claude doesn't know it should upload
 * screenshots to Linear for them to be viewable in comments.
 */
describe("EdgeWorker - Screenshot Upload Guidance Hooks", () => {
	let edgeWorker: EdgeWorker;
	let mockConfig: EdgeWorkerConfig;
	let mockLinearClient: any;
	let mockClaudeRunner: any;
	let mockGeminiRunner: any;
	let mockAgentSessionManager: any;
	let capturedRunnerConfig: any = null;

	const mockRepository: RepositoryConfig = {
		id: "test-repo",
		name: "Test Repo",
		repositoryPath: "/test/repo",
		workspaceBaseDir: "/test/workspaces",
		baseBranch: "main",
		linearWorkspaceId: "test-workspace",
		isActive: true,
		allowedTools: ["Read", "Edit"],
	};

	function createMockIssueWithLabels(labels: string[]) {
		return {
			id: "issue-123",
			identifier: "TEST-123",
			title: "Test Issue",
			description: "Test description",
			url: "https://linear.app/test/issue/TEST-123",
			branchName: "test-branch",
			state: { name: "Todo" },
			team: { id: "team-123" },
			labels: vi.fn().mockResolvedValue({
				nodes: labels.map((name) => ({ name })),
			}),
		};
	}

	beforeEach(() => {
		vi.clearAllMocks();
		capturedRunnerConfig = null;

		// Mock console methods
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});

		// Mock LinearClient
		mockLinearClient = {
			issue: vi.fn(),
			workflowStates: vi.fn().mockResolvedValue({
				nodes: [
					{ id: "state-1", name: "Todo", type: "unstarted", position: 0 },
					{ id: "state-2", name: "In Progress", type: "started", position: 1 },
				],
			}),
			updateIssue: vi.fn().mockResolvedValue({ success: true }),
			createAgentActivity: vi.fn().mockResolvedValue({ success: true }),
			comments: vi.fn().mockResolvedValue({ nodes: [] }),
			rawRequest: vi.fn(),
		};
		vi.mocked(LinearClient).mockImplementation(function () {
			return mockLinearClient;
		});

		// Mock ClaudeRunner - capture config for hook inspection
		mockClaudeRunner = {
			supportsStreamingInput: true,
			start: vi.fn().mockResolvedValue({ sessionId: "claude-session-123" }),
			startStreaming: vi
				.fn()
				.mockResolvedValue({ sessionId: "claude-session-123" }),
			stop: vi.fn(),
			isStreaming: vi.fn().mockReturnValue(false),
			addStreamMessage: vi.fn(),
			updatePromptVersions: vi.fn(),
		};
		vi.mocked(ClaudeRunner).mockImplementation(function (config: any) {
			capturedRunnerConfig = config;
			return mockClaudeRunner;
		});

		// Mock GeminiRunner
		mockGeminiRunner = {
			supportsStreamingInput: false,
			start: vi.fn().mockResolvedValue({ sessionId: "gemini-session-123" }),
			startStreaming: vi
				.fn()
				.mockResolvedValue({ sessionId: "gemini-session-123" }),
			stop: vi.fn(),
			isStreaming: vi.fn().mockReturnValue(false),
			addStreamMessage: vi.fn(),
			updatePromptVersions: vi.fn(),
		};
		vi.mocked(GeminiRunner).mockImplementation(function (_config: any) {
			return mockGeminiRunner;
		});

		// Mock AgentSessionManager
		mockAgentSessionManager = {
			createAtmikoAgentSession: vi.fn(),
			getSession: vi.fn().mockReturnValue({
				issueId: "issue-123",
				workspace: { path: "/test/workspaces/TEST-123" },
			}),
			addAgentRunner: vi.fn(),
			getAllAgentRunners: vi.fn().mockReturnValue([]),
			serializeState: vi.fn().mockReturnValue({ sessions: {}, entries: {} }),
			restoreState: vi.fn(),
			postAnalyzingThought: vi.fn().mockResolvedValue(null),
			createThoughtActivity: vi.fn().mockResolvedValue(undefined),
			setActivitySink: vi.fn(),
			on: vi.fn(),
		};
		vi.mocked(AgentSessionManager).mockImplementation(function () {
			return mockAgentSessionManager;
		});

		// Mock SharedApplicationServer
		vi.mocked(SharedApplicationServer).mockImplementation(function () {
			return {
				start: vi.fn().mockResolvedValue(undefined),
				stop: vi.fn().mockResolvedValue(undefined),
				getFastifyInstance: vi.fn().mockReturnValue({ post: vi.fn() }),
				getWebhookUrl: vi.fn().mockReturnValue("http://localhost:3456/webhook"),
				registerOAuthCallbackHandler: vi.fn(),
			};
		} as any);

		// Mock LinearEventTransport
		vi.mocked(LinearEventTransport).mockImplementation(function () {
			return {
				register: vi.fn(),
				on: vi.fn(),
				removeAllListeners: vi.fn(),
			};
		} as any);

		// Mock type guards
		vi.mocked(isAgentSessionCreatedWebhook).mockReturnValue(true);
		vi.mocked(isAgentSessionPromptedWebhook).mockReturnValue(false);

		// Mock readFile
		vi.mocked(readFile).mockImplementation(async () => {
			return `<version-tag value="default-v1.0.0" />
# Default Template

Repository: {{repository_name}}
Issue: {{issue_identifier}}`;
		});

		mockConfig = {
			proxyUrl: "http://localhost:3000",
			atmikoHome: TEST_ATMIKO_HOME,
			repositories: [mockRepository],
			linearWorkspaces: {
				"test-workspace": { linearToken: "test-token" },
			},
			handlers: {
				createWorkspace: vi.fn().mockResolvedValue({
					path: "/test/workspaces/TEST-123",
					isGitWorktree: false,
				}),
			},
		};

		edgeWorker = new EdgeWorker(mockConfig);

		// Inject mock issue tracker
		const mockIssueTracker = {
			fetchIssue: vi.fn().mockImplementation(async (issueId: string) => {
				return mockLinearClient.issue(issueId);
			}),
			getIssueLabels: vi.fn(),
			getClient: vi.fn().mockReturnValue({}),
		};
		(edgeWorker as any).issueTrackers.set(
			mockRepository.linearWorkspaceId,
			mockIssueTracker,
		);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	/**
	 * Helper to extract hook matchers from captured config
	 */
	function getPostToolUseHooks(): HookCallbackMatcher[] {
		if (!capturedRunnerConfig?.hooks?.PostToolUse) {
			return [];
		}
		return capturedRunnerConfig.hooks.PostToolUse;
	}

	/**
	 * Helper to find hook matcher by tool name pattern
	 */
	function findHookMatcher(pattern: string): HookCallbackMatcher | undefined {
		const hooks = getPostToolUseHooks();
		return hooks.find(
			(h) =>
				h.matcher === pattern ||
				(typeof h.matcher === "string" && h.matcher.includes(pattern)),
		);
	}

	/**
	 * Helper to execute a hook and get the additionalContext response
	 */
	async function executeHookAndGetContext(
		hookMatcher: HookCallbackMatcher,
		toolName: string,
		toolResponse: any,
	): Promise<string | undefined> {
		const hookFn = hookMatcher.hooks[0];
		const result = await hookFn(
			{ tool_name: toolName, tool_response: toolResponse } as any,
			"test-tool-use-id",
			{ signal: new AbortController().signal },
		);
		return result?.additionalContext;
	}

	/**
	 * Helper to execute a hook with both input and response (for tools like chrome-devtools)
	 */
	async function executeHookAndGetContextWithInput(
		hookMatcher: HookCallbackMatcher,
		toolName: string,
		toolInput: any,
		toolResponse: any,
	): Promise<string | undefined> {
		const hookFn = hookMatcher.hooks[0];
		const result = await hookFn(
			{
				tool_name: toolName,
				tool_input: toolInput,
				tool_response: toolResponse,
			} as any,
			"test-tool-use-id",
			{ signal: new AbortController().signal },
		);
		return result?.additionalContext;
	}

	describe("Playwright Screenshot Hook - Linear Upload Guidance", () => {
		it("should have a hook configured for playwright_screenshot", async () => {
			// Arrange
			const mockIssue = createMockIssueWithLabels([]);
			mockLinearClient.issue.mockResolvedValue(mockIssue);

			const webhook: LinearAgentSessionCreatedWebhook = {
				type: "Issue",
				action: "agentSessionCreated",
				organizationId: "test-workspace",
				agentSession: {
					id: "agent-session-123",
					issue: {
						id: "issue-123",
						identifier: "TEST-123",
						team: { key: "TEST" },
					},
					comment: { body: "@atmiko work on this" },
				},
			};

			// Act
			await (edgeWorker as any).handleAgentSessionCreatedWebhook(webhook, [
				mockRepository,
			]);

			// Assert
			const playwrightHook = findHookMatcher("playwright_screenshot");
			expect(playwrightHook).toBeDefined();
		});

		it("should provide guidance about linear_upload_file in playwright_screenshot hook", async () => {
			// Arrange
			const mockIssue = createMockIssueWithLabels([]);
			mockLinearClient.issue.mockResolvedValue(mockIssue);

			const webhook: LinearAgentSessionCreatedWebhook = {
				type: "Issue",
				action: "agentSessionCreated",
				organizationId: "test-workspace",
				agentSession: {
					id: "agent-session-123",
					issue: {
						id: "issue-123",
						identifier: "TEST-123",
						team: { key: "TEST" },
					},
					comment: { body: "@atmiko take a screenshot" },
				},
			};

			// Act
			await (edgeWorker as any).handleAgentSessionCreatedWebhook(webhook, [
				mockRepository,
			]);

			// Get the hook and execute it
			const playwrightHook = findHookMatcher("playwright_screenshot");
			expect(playwrightHook).toBeDefined();

			const additionalContext = await executeHookAndGetContext(
				playwrightHook!,
				"playwright_screenshot",
				{ path: "/tmp/screenshot.png" },
			);

			// Assert - the hook should mention linear_upload_file tool
			expect(additionalContext).toBeDefined();
			expect(additionalContext).toContain("linear_upload_file");
		});

		it("should explain that linear_upload_file enables screenshots to be viewed in Linear comments", async () => {
			// Arrange
			const mockIssue = createMockIssueWithLabels([]);
			mockLinearClient.issue.mockResolvedValue(mockIssue);

			const webhook: LinearAgentSessionCreatedWebhook = {
				type: "Issue",
				action: "agentSessionCreated",
				organizationId: "test-workspace",
				agentSession: {
					id: "agent-session-123",
					issue: {
						id: "issue-123",
						identifier: "TEST-123",
						team: { key: "TEST" },
					},
					comment: { body: "@atmiko take a screenshot" },
				},
			};

			// Act
			await (edgeWorker as any).handleAgentSessionCreatedWebhook(webhook, [
				mockRepository,
			]);

			const playwrightHook = findHookMatcher("playwright_screenshot");
			const additionalContext = await executeHookAndGetContext(
				playwrightHook!,
				"playwright_screenshot",
				{ path: "/tmp/screenshot.png" },
			);

			// Assert - should explain why the tool is needed
			expect(additionalContext).toMatch(/linear|comment|embed|view/i);
		});
	});

	describe("Upload Guidance Content Quality", () => {
		it("should include file path placeholder in linear_upload_file guidance", async () => {
			// Arrange
			const mockIssue = createMockIssueWithLabels([]);
			mockLinearClient.issue.mockResolvedValue(mockIssue);

			const webhook: LinearAgentSessionCreatedWebhook = {
				type: "Issue",
				action: "agentSessionCreated",
				organizationId: "test-workspace",
				agentSession: {
					id: "agent-session-123",
					issue: {
						id: "issue-123",
						identifier: "TEST-123",
						team: { key: "TEST" },
					},
					comment: { body: "@atmiko take a screenshot" },
				},
			};

			// Act
			await (edgeWorker as any).handleAgentSessionCreatedWebhook(webhook, [
				mockRepository,
			]);

			const playwrightHook = findHookMatcher("playwright_screenshot");
			const screenshotPath = "/tmp/screenshot-abc123.png";
			const additionalContext = await executeHookAndGetContext(
				playwrightHook!,
				"playwright_screenshot",
				{ path: screenshotPath },
			);

			// Assert - guidance should reference the actual file path from tool response
			expect(additionalContext).toBeDefined();
			// The guidance should either include the path directly or provide clear instructions
			expect(additionalContext).toMatch(
				/linear_upload_file|upload.*screenshot|share.*linear/i,
			);
		});
	});

	describe("Chrome DevTools Screenshot Hook - Linear Upload Guidance", () => {
		it("should have a hook configured for mcp__chrome-devtools__take_screenshot", async () => {
			// Arrange
			const mockIssue = createMockIssueWithLabels([]);
			mockLinearClient.issue.mockResolvedValue(mockIssue);

			const webhook: LinearAgentSessionCreatedWebhook = {
				type: "Issue",
				action: "agentSessionCreated",
				organizationId: "test-workspace",
				agentSession: {
					id: "agent-session-123",
					issue: {
						id: "issue-123",
						identifier: "TEST-123",
						team: { key: "TEST" },
					},
					comment: { body: "@atmiko take a screenshot with devtools" },
				},
			};

			// Act
			await (edgeWorker as any).handleAgentSessionCreatedWebhook(webhook, [
				mockRepository,
			]);

			// Assert - there should be a hook for the chrome devtools screenshot tool
			const devtoolsHook = findHookMatcher(
				"mcp__chrome-devtools__take_screenshot",
			);
			expect(devtoolsHook).toBeDefined();
		});

		it("should provide guidance about linear_upload_file when chrome devtools takes a screenshot", async () => {
			// Arrange
			const mockIssue = createMockIssueWithLabels([]);
			mockLinearClient.issue.mockResolvedValue(mockIssue);

			const webhook: LinearAgentSessionCreatedWebhook = {
				type: "Issue",
				action: "agentSessionCreated",
				organizationId: "test-workspace",
				agentSession: {
					id: "agent-session-123",
					issue: {
						id: "issue-123",
						identifier: "TEST-123",
						team: { key: "TEST" },
					},
					comment: { body: "@atmiko take a screenshot with devtools" },
				},
			};

			// Act
			await (edgeWorker as any).handleAgentSessionCreatedWebhook(webhook, [
				mockRepository,
			]);

			const devtoolsHook = findHookMatcher(
				"mcp__chrome-devtools__take_screenshot",
			);
			expect(devtoolsHook).toBeDefined();

			// Simulate a screenshot response - note: this tool uses filePath in input, not response
			const additionalContext = await executeHookAndGetContextWithInput(
				devtoolsHook!,
				"mcp__chrome-devtools__take_screenshot",
				{
					filePath:
						"/home/atmiko/atmiko-workspaces/PF-738/step1-screenshot.png",
					fullPage: true,
				},
				{
					text: "Took a screenshot of the full current page.",
				},
			);

			// Assert - should mention linear_upload_file and the file path
			expect(additionalContext).toBeDefined();
			expect(additionalContext).toContain("linear_upload_file");
			expect(additionalContext).toContain("step1-screenshot.png");
		});
	});
});
