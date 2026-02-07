import { readFile } from "node:fs/promises";
import { LinearClient } from "@linear/sdk";
import { ClaudeRunner } from "cyrus-claude-runner";
import type { LinearAgentSessionCreatedWebhook } from "cyrus-core";
import {
	isAgentSessionCreatedWebhook,
	isAgentSessionPromptedWebhook,
} from "cyrus-core";
import { LinearEventTransport } from "cyrus-linear-event-transport";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager.js";
import { EdgeWorker } from "../src/EdgeWorker.js";
import { SharedApplicationServer } from "../src/SharedApplicationServer.js";
import type { EdgeWorkerConfig, RepositoryConfig } from "../src/types.js";

// Mock fs/promises
vi.mock("fs/promises", () => ({
	readFile: vi.fn(),
	writeFile: vi.fn(),
	mkdir: vi.fn(),
	rename: vi.fn(),
}));

// Mock dependencies
vi.mock("cyrus-claude-runner");
vi.mock("cyrus-linear-event-transport");
vi.mock("@linear/sdk");
vi.mock("../src/SharedApplicationServer.js");
vi.mock("../src/AgentSessionManager.js");
vi.mock("cyrus-core", async (importOriginal) => {
	const actual = (await importOriginal()) as any;
	return {
		...actual,
		isAgentSessionCreatedWebhook: vi.fn(),
		isAgentSessionPromptedWebhook: vi.fn(),
		PersistenceManager: vi.fn().mockImplementation(() => ({
			loadEdgeWorkerState: vi.fn().mockResolvedValue(null),
			saveEdgeWorkerState: vi.fn().mockResolvedValue(undefined),
		})),
	};
});
vi.mock("file-type");

describe("EdgeWorker - Label-Based Prompt Command", () => {
	let edgeWorker: EdgeWorker;
	let mockConfig: EdgeWorkerConfig;
	let mockLinearClient: any;
	let mockClaudeRunner: any;
	let mockAgentSessionManager: any;
	let capturedPrompt: string | null = null;
	let capturedClaudeRunnerConfig: any = null;

	const mockRepository: RepositoryConfig = {
		id: "test-repo",
		name: "Test Repo",
		repositoryPath: "/test/repo",
		workspaceBaseDir: "/test/workspaces",
		baseBranch: "main",
		linearToken: "test-token",
		linearWorkspaceId: "test-workspace",
		isActive: true,
		allowedTools: ["Read", "Edit"],
		labelPrompts: {
			debugger: ["bug", "error"],
			builder: ["feature", "enhancement"],
			scoper: ["scope", "research"],
		},
	};

	beforeEach(() => {
		vi.clearAllMocks();
		capturedPrompt = null;
		capturedClaudeRunnerConfig = null;

		// Mock console methods
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});

		// Mock LinearClient
		mockLinearClient = {
			issue: vi.fn().mockResolvedValue({
				id: "issue-123",
				identifier: "TEST-123",
				title: "Test Issue with Bug",
				description: "This is a bug that needs fixing",
				url: "https://linear.app/test/issue/TEST-123",
				branchName: "test-branch",
				state: { name: "Todo" },
				team: { id: "team-123" },
				labels: vi.fn().mockResolvedValue({
					nodes: [{ name: "bug" }], // This should trigger debugger prompt
				}),
			}),
			workflowStates: vi.fn().mockResolvedValue({
				nodes: [
					{ id: "state-1", name: "Todo", type: "unstarted", position: 0 },
					{ id: "state-2", name: "In Progress", type: "started", position: 1 },
				],
			}),
			updateIssue: vi.fn().mockResolvedValue({ success: true }),
			createAgentActivity: vi.fn().mockResolvedValue({ success: true }),
			comments: vi.fn().mockResolvedValue({ nodes: [] }),
			rawRequest: vi.fn(), // Add rawRequest to avoid validation warnings
		};
		vi.mocked(LinearClient).mockImplementation(() => mockLinearClient);

		// Mock ClaudeRunner to capture prompt
		mockClaudeRunner = {
			supportsStreamingInput: true,
			start: vi.fn().mockImplementation((prompt: string) => {
				capturedPrompt = prompt;
				return Promise.resolve({ sessionId: "claude-session-123" });
			}),
			startStreaming: vi.fn().mockImplementation((prompt: string) => {
				capturedPrompt = prompt;
				return Promise.resolve({ sessionId: "claude-session-123" });
			}),
			stop: vi.fn(),
			isStreaming: vi.fn().mockReturnValue(false),
			addStreamMessage: vi.fn(),
			updatePromptVersions: vi.fn(),
		};
		vi.mocked(ClaudeRunner).mockImplementation((config: any) => {
			capturedClaudeRunnerConfig = config;
			return mockClaudeRunner;
		});

		// Mock AgentSessionManager
		mockAgentSessionManager = {
			createLinearAgentSession: vi.fn(),
			getSession: vi.fn().mockReturnValue({
				claudeSessionId: "claude-session-123",
				workspace: { path: "/test/workspaces/TEST-123" },
				claudeRunner: mockClaudeRunner,
			}),
			addAgentRunner: vi.fn(),
			getAllAgentRunners: vi.fn().mockReturnValue([]),
			serializeState: vi.fn().mockReturnValue({ sessions: {}, entries: {} }),
			restoreState: vi.fn(),
			postAnalyzingThought: vi.fn().mockResolvedValue(null),
			postProcedureSelectionThought: vi.fn().mockResolvedValue(undefined),
			on: vi.fn(), // EventEmitter method
		};
		vi.mocked(AgentSessionManager).mockImplementation(
			() => mockAgentSessionManager,
		);

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
					registerOAuthCallbackHandler: vi.fn(),
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

		// Mock type guards for mention-triggered sessions
		vi.mocked(isAgentSessionCreatedWebhook).mockReturnValue(true);
		vi.mocked(isAgentSessionPromptedWebhook).mockReturnValue(false);

		// Mock readFile to return debugger prompt template and label-based prompt template
		vi.mocked(readFile).mockImplementation(async (path: any) => {
			if (path.includes("debugger.md")) {
				return `<version-tag value="debugger-v1.0.0" />
# Debugger System Prompt

You are in debugger mode. Fix bugs systematically.`;
			}
			if (path.includes("label-prompt-template.md")) {
				return `<version-tag value="label-based-v1.0.0" />
# Label-Based System Prompt

Repository: {{repository_name}}
Issue: {{issue_identifier}}
Title: {{issue_title}}

You are working on this Linear issue. Use the available tools to complete the task.`;
			}
			// Return default template
			return `<version-tag value="default-v1.0.0" />
# Default Template

Repository: {{repository_name}}
Issue: {{issue_identifier}}`;
		});

		mockConfig = {
			proxyUrl: "http://localhost:3000",
			cyrusHome: "/tmp/test-cyrus-home",
			repositories: [mockRepository],
			handlers: {
				createWorkspace: vi.fn().mockResolvedValue({
					path: "/test/workspaces/TEST-123",
					isGitWorktree: false,
				}),
			},
		};

		edgeWorker = new EdgeWorker(mockConfig);

		// Inject mock issue tracker for the test repository
		const mockIssueTracker = {
			fetchIssue: vi.fn().mockImplementation(async (issueId: string) => {
				return mockLinearClient.issue(issueId);
			}),
			getIssueLabels: vi.fn().mockResolvedValue([{ name: "bug" }]),
			getClient: vi.fn().mockReturnValue({}),
		};
		(edgeWorker as any).issueTrackers.set(mockRepository.id, mockIssueTracker);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("should use label-based prompt when /label-based-prompt command is mentioned", async () => {
		// Arrange
		const createdWebhook: LinearAgentSessionCreatedWebhook = {
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
				comment: {
					body: "@cyrus /label-based-prompt can you work on this issue?",
				},
			},
		};

		// Act
		const handleAgentSessionCreatedWebhook = (
			edgeWorker as any
		).handleAgentSessionCreatedWebhook.bind(edgeWorker);
		await handleAgentSessionCreatedWebhook(createdWebhook, [mockRepository]);

		// Assert
		expect(vi.mocked(ClaudeRunner)).toHaveBeenCalled();
		expect(capturedPrompt).toBeDefined();
		expect(capturedPrompt).not.toBeNull();

		// Should use label-based prompt template, not mention prompt
		expect(capturedPrompt).toContain("Repository: Test Repo");
		expect(capturedPrompt).toContain("Issue: TEST-123");
		expect(capturedPrompt).toContain("Title: Test Issue with Bug");
		expect(capturedPrompt).toContain("You are working on this Linear issue");

		// Should NOT contain mention-specific text
		expect(capturedPrompt).not.toContain(
			"You were mentioned in a Linear comment",
		);
		expect(capturedPrompt).not.toContain("<mention_request>");
	});

	it("should use regular mention prompt when /label-based-prompt is NOT mentioned", async () => {
		// Arrange
		const createdWebhook: LinearAgentSessionCreatedWebhook = {
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
				comment: {
					body: "@cyrus can you help me with this issue?",
				},
			},
		};

		// Act
		const handleAgentSessionCreatedWebhook = (
			edgeWorker as any
		).handleAgentSessionCreatedWebhook.bind(edgeWorker);
		await handleAgentSessionCreatedWebhook(createdWebhook, [mockRepository]);

		// Assert
		expect(vi.mocked(ClaudeRunner)).toHaveBeenCalled();
		expect(capturedPrompt).toBeDefined();
		expect(capturedPrompt).not.toBeNull();

		// Should use mention prompt template
		expect(capturedPrompt).toContain("You were mentioned in a Linear comment");
		expect(capturedPrompt).toContain("<mention_comment>");
		expect(capturedPrompt).toContain("@cyrus can you help me with this issue?");

		// Should NOT contain label-based prompt template text
		expect(capturedPrompt).not.toContain(
			"You are working on this Linear issue",
		);
	});

	it("should include system prompt when /label-based-prompt is used", async () => {
		// Arrange
		const createdWebhook: LinearAgentSessionCreatedWebhook = {
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
				comment: {
					body: "@cyrus /label-based-prompt please debug this issue",
				},
			},
		};

		// Act
		const handleAgentSessionCreatedWebhook = (
			edgeWorker as any
		).handleAgentSessionCreatedWebhook.bind(edgeWorker);
		await handleAgentSessionCreatedWebhook(createdWebhook, [mockRepository]);

		// Assert
		expect(vi.mocked(ClaudeRunner)).toHaveBeenCalled();
		expect(capturedClaudeRunnerConfig).toBeDefined();

		// Should include system prompt based on labels (bug -> debugger)
		expect(capturedClaudeRunnerConfig.appendSystemPrompt).toContain(
			"You are in debugger mode. Fix bugs systematically.",
		);
		// Note: LAST_MESSAGE_MARKER removed as part of three-phase execution system
	});

	it("should NOT include system prompt content for regular mentions without /label-based-prompt", async () => {
		// Arrange
		const createdWebhook: LinearAgentSessionCreatedWebhook = {
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
				comment: {
					body: "@cyrus please help with this bug",
				},
			},
		};

		// Act
		const handleAgentSessionCreatedWebhook = (
			edgeWorker as any
		).handleAgentSessionCreatedWebhook.bind(edgeWorker);
		await handleAgentSessionCreatedWebhook(createdWebhook, [mockRepository]);

		// Assert
		expect(vi.mocked(ClaudeRunner)).toHaveBeenCalled();
		expect(capturedClaudeRunnerConfig).toBeDefined();

		// Should NOT include debugger system prompt for regular mentions - only the marker
		expect(capturedClaudeRunnerConfig.appendSystemPrompt).not.toContain(
			"You are in debugger mode. Fix bugs systematically.",
		);
		// Note: LAST_MESSAGE_MARKER removed as part of three-phase execution system
	});
});
