import { LinearClient } from "@linear/sdk";
import { ClaudeRunner, createCyrusToolsServer } from "cyrus-claude-runner";
import { LinearEventTransport } from "cyrus-linear-event-transport";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager.js";
import { EdgeWorker } from "../src/EdgeWorker.js";
import { SharedApplicationServer } from "../src/SharedApplicationServer.js";
import type { EdgeWorkerConfig, RepositoryConfig } from "../src/types.js";

// Mock all dependencies
vi.mock("fs/promises");
vi.mock("cyrus-claude-runner");
vi.mock("cyrus-linear-event-transport");
vi.mock("@linear/sdk");
vi.mock("../src/SharedApplicationServer.js");
vi.mock("../src/AgentSessionManager.js");
vi.mock("cyrus-core", async (importOriginal) => {
	const actual = (await importOriginal()) as any;
	return {
		...actual,
		PersistenceManager: vi.fn().mockImplementation(() => ({
			loadEdgeWorkerState: vi.fn().mockResolvedValue(null),
			saveEdgeWorkerState: vi.fn().mockResolvedValue(undefined),
		})),
	};
});

describe("EdgeWorker - Feedback Delivery", () => {
	let edgeWorker: EdgeWorker;
	let mockConfig: EdgeWorkerConfig;
	let mockAgentSessionManager: any;
	let mockChildAgentSessionManager: any;
	let mockClaudeRunner: any;
	let resumeAgentSessionSpy: any;
	let mockOnFeedbackDelivery: any;
	let mockOnSessionCreated: any;

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
		labelPrompts: {},
	};

	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});

		// Setup callbacks to be captured
		mockOnFeedbackDelivery = vi.fn();
		mockOnSessionCreated = vi.fn();

		// Mock createCyrusToolsServer to return a proper structure
		vi.mocked(createCyrusToolsServer).mockImplementation((_token, options) => {
			// Capture the callbacks
			if (options?.onFeedbackDelivery) {
				mockOnFeedbackDelivery = options.onFeedbackDelivery;
			}
			if (options?.onSessionCreated) {
				mockOnSessionCreated = options.onSessionCreated;
			}

			// Return a mock structure that matches what the real function returns
			return {
				type: "sdk" as const,
				name: "cyrus-tools",
				instance: {
					_options: options,
				},
			} as any;
		});

		// Mock ClaudeRunner
		mockClaudeRunner = {
			supportsStreamingInput: true,
			startStreaming: vi
				.fn()
				.mockResolvedValue({ sessionId: "claude-session-123" }),
			stop: vi.fn(),
			isStreaming: vi.fn().mockReturnValue(false),
		};
		vi.mocked(ClaudeRunner).mockImplementation(() => mockClaudeRunner);

		// Mock child session manager
		mockChildAgentSessionManager = {
			hasAgentRunner: vi.fn().mockReturnValue(true),
			getSession: vi.fn().mockReturnValue({
				issueId: "CHILD-456",
				claudeSessionId: "child-claude-session-456",
				workspace: { path: "/test/workspaces/CHILD-456" },
				claudeRunner: mockClaudeRunner,
			}),
			getAgentRunner: vi.fn().mockReturnValue(mockClaudeRunner),
			postAnalyzingThought: vi.fn().mockResolvedValue(undefined),
			postProcedureSelectionThought: vi.fn().mockResolvedValue(undefined),
			on: vi.fn(), // EventEmitter method
		};

		// Mock parent session manager (for different repository)
		mockAgentSessionManager = {
			hasAgentRunner: vi.fn().mockReturnValue(false),
			getSession: vi.fn().mockReturnValue(null),
			on: vi.fn(), // EventEmitter method
		};

		// Mock AgentSessionManager constructor
		vi.mocked(AgentSessionManager).mockImplementation(
			(_linearClient, ..._args) => {
				// Return different managers based on some condition
				// In real usage, these would be created per repository
				return mockAgentSessionManager;
			},
		);

		// Mock other dependencies
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
					users: {
						me: vi.fn().mockResolvedValue({
							id: "user-123",
							name: "Test User",
						}),
					},
				}) as any,
		);

		mockConfig = {
			proxyUrl: "http://localhost:3000",
			cyrusHome: "/tmp/test-cyrus-home",
			repositories: [mockRepository],
			handlers: {
				createWorkspace: vi.fn().mockResolvedValue({
					path: "/test/workspaces/CHILD-456",
					isGitWorktree: false,
				}),
			},
		};

		edgeWorker = new EdgeWorker(mockConfig);

		// Spy on resumeAgentSession method
		resumeAgentSessionSpy = vi
			.spyOn(edgeWorker as any, "resumeAgentSession")
			.mockResolvedValue(undefined);

		// Setup parent-child mapping
		(edgeWorker as any).childToParentAgentSession.set(
			"child-session-456",
			"parent-session-123",
		);

		// Setup repository managers
		(edgeWorker as any).agentSessionManagers.set(
			"test-repo",
			mockChildAgentSessionManager,
		);
		(edgeWorker as any).repositories.set("test-repo", mockRepository);

		// Setup mock issueTracker with getClient()
		const mockIssueTracker = {
			getClient: vi.fn().mockReturnValue({}),
		};
		(edgeWorker as any).issueTrackers.set("test-repo", mockIssueTracker);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("Parent to Child Feedback Flow", () => {
		it("should deliver feedback FROM parent TO child session and resume the child", async () => {
			// Arrange
			const childSessionId = "child-session-456";
			const feedbackMessage =
				"Please revise your approach and focus on the error handling";
			const parentSessionId = "parent-session-123";

			// Build MCP config which will trigger createCyrusToolsServer
			const _mcpConfig = (edgeWorker as any).buildMcpConfig(
				mockRepository,
				parentSessionId,
			);

			// Act - Call the captured feedback delivery callback
			const result = await mockOnFeedbackDelivery(
				childSessionId,
				feedbackMessage,
			);

			// Assert
			expect(result).toBe(true);

			// Wait for the async handlePromptWithStreamingCheck to complete (fire-and-forget pattern)
			await new Promise((resolve) => setTimeout(resolve, 100));

			expect(resumeAgentSessionSpy).toHaveBeenCalledOnce();

			const resumeArgs = resumeAgentSessionSpy.mock.calls[0];
			const [
				childSession,
				repo,
				sessionId,
				_manager,
				prompt,
				attachmentManifest,
				isNewSession,
				additionalAllowedDirectories,
			] = resumeArgs;

			// Verify the CHILD session is resumed, not the parent
			expect(sessionId).toBe(childSessionId);
			expect(childSession.issueId).toBe("CHILD-456");
			expect(childSession.claudeSessionId).toBe("child-claude-session-456");

			// Verify correct prompt format with enhanced markdown: feedback FROM parent TO child
			expect(prompt).toBe(
				`## Received feedback from orchestrator\n\n---\n\n${feedbackMessage}\n\n---`,
			);

			// Verify repository is passed correctly
			expect(repo).toBe(mockRepository);

			// Verify no attachments for feedback
			expect(attachmentManifest).toBe("");

			// Verify it's not a new session
			expect(isNewSession).toBe(false);

			// Verify no additional allowed directories for feedback (empty array)
			expect(additionalAllowedDirectories).toEqual([]);
		});

		it("should handle feedback delivery when parent session ID is unknown", async () => {
			// Arrange - Remove parent mapping to test unknown parent scenario
			(edgeWorker as any).childToParentAgentSession.delete("child-session-456");

			const childSessionId = "child-session-456";
			const feedbackMessage = "Test feedback without known parent";

			// Build MCP config which will trigger createCyrusToolsServer
			const _mcpConfig = (edgeWorker as any).buildMcpConfig(
				mockRepository,
				undefined, // No parent session ID
			);

			// Act - Call the captured feedback delivery callback
			const result = await mockOnFeedbackDelivery(
				childSessionId,
				feedbackMessage,
			);

			// Assert - Should still work but with generic parent reference
			expect(result).toBe(true);

			// Wait for the async handlePromptWithStreamingCheck to complete (fire-and-forget pattern)
			await new Promise((resolve) => setTimeout(resolve, 100));

			expect(resumeAgentSessionSpy).toHaveBeenCalledOnce();

			const prompt = resumeAgentSessionSpy.mock.calls[0][4];
			expect(prompt).toBe(
				`## Received feedback from orchestrator\n\n---\n\n${feedbackMessage}\n\n---`,
			);
		});

		it("should return false when child session is not found in any repository", async () => {
			// Arrange
			mockChildAgentSessionManager.hasAgentRunner.mockReturnValue(false);

			const childSessionId = "nonexistent-child-session";
			const feedbackMessage = "This should fail";

			// Build MCP config which will trigger createCyrusToolsServer
			const _mcpConfig = (edgeWorker as any).buildMcpConfig(
				mockRepository,
				"parent-session-123",
			);

			// Act - Call the captured feedback delivery callback
			const result = await mockOnFeedbackDelivery(
				childSessionId,
				feedbackMessage,
			);

			// Assert
			expect(result).toBe(false);
			expect(resumeAgentSessionSpy).not.toHaveBeenCalled();
			expect(console.error).toHaveBeenCalledWith(
				`[EdgeWorker] Child session ${childSessionId} not found in any repository`,
			);
		});

		it("should return false when child session data is not found in manager", async () => {
			// Arrange
			mockChildAgentSessionManager.getSession.mockReturnValue(null);

			const childSessionId = "child-session-456";
			const feedbackMessage = "This should also fail";

			// Build MCP config which will trigger createCyrusToolsServer
			const _mcpConfig = (edgeWorker as any).buildMcpConfig(
				mockRepository,
				"parent-session-123",
			);

			// Act - Call the captured feedback delivery callback
			const result = await mockOnFeedbackDelivery(
				childSessionId,
				feedbackMessage,
			);

			// Assert
			expect(result).toBe(false);
			expect(resumeAgentSessionSpy).not.toHaveBeenCalled();
			expect(console.error).toHaveBeenCalledWith(
				`[EdgeWorker] Child session ${childSessionId} not found`,
			);
		});

		it("should handle resumeAgentSession errors gracefully", async () => {
			// Arrange
			resumeAgentSessionSpy.mockRejectedValue(new Error("Resume failed"));

			const childSessionId = "child-session-456";
			const feedbackMessage = "This will cause resume to fail";

			// Build MCP config which will trigger createCyrusToolsServer
			const _mcpConfig = (edgeWorker as any).buildMcpConfig(
				mockRepository,
				"parent-session-123",
			);

			// Act - Call the captured feedback delivery callback
			const result = await mockOnFeedbackDelivery(
				childSessionId,
				feedbackMessage,
			);

			// Assert - Now returns true immediately (fire-and-forget)
			expect(result).toBe(true);

			// Wait for the async handlePromptWithStreamingCheck to complete (fire-and-forget pattern)
			await new Promise((resolve) => setTimeout(resolve, 100));

			expect(resumeAgentSessionSpy).toHaveBeenCalledOnce();

			// Wait a bit for the async error handling to occur
			await new Promise((resolve) => setTimeout(resolve, 100));

			// The error is logged asynchronously
			expect(console.error).toHaveBeenCalledWith(
				`[EdgeWorker] Failed to process feedback in child session:`,
				expect.any(Error),
			);
		});

		it("should find child session across multiple repositories", async () => {
			// Arrange - Setup multiple repositories
			const repo2: RepositoryConfig = {
				...mockRepository,
				id: "test-repo-2",
				name: "Test Repo 2",
			};

			const mockRepo2Manager = {
				hasAgentRunner: vi.fn().mockReturnValue(false),
				getSession: vi.fn().mockReturnValue(null),
			};

			// First repository doesn't have the session
			(edgeWorker as any).agentSessionManagers.set(
				"test-repo-2",
				mockRepo2Manager,
			);
			(edgeWorker as any).repositories.set("test-repo-2", repo2);

			// Adjust mock to make first repo not have it, second repo has it
			mockRepo2Manager.hasAgentRunner.mockReturnValue(false);
			mockChildAgentSessionManager.hasAgentRunner.mockReturnValue(true);

			const childSessionId = "child-session-456";
			const feedbackMessage = "Test feedback across repositories";

			// Build MCP config which will trigger createCyrusToolsServer
			const _mcpConfig = (edgeWorker as any).buildMcpConfig(
				mockRepository,
				"parent-session-123",
			);

			// Act - Call the captured feedback delivery callback
			const result = await mockOnFeedbackDelivery(
				childSessionId,
				feedbackMessage,
			);

			// Assert - Should find the child in the correct repository
			expect(result).toBe(true);

			// Wait for the async handlePromptWithStreamingCheck to complete (fire-and-forget pattern)
			await new Promise((resolve) => setTimeout(resolve, 100));

			expect(resumeAgentSessionSpy).toHaveBeenCalledOnce();

			// Verify the child was found in one of the repositories
			const hasAgentRunnerCalls =
				mockRepo2Manager.hasAgentRunner.mock.calls.length +
				mockChildAgentSessionManager.hasAgentRunner.mock.calls.length;
			expect(hasAgentRunnerCalls).toBeGreaterThan(0);
		});
	});

	describe("Integration with cyrus-tools server", () => {
		it("should properly configure feedback delivery callback in MCP config", () => {
			// Arrange
			const parentSessionId = "parent-session-123";

			// Act
			const _mcpConfig = (edgeWorker as any).buildMcpConfig(
				mockRepository,
				parentSessionId,
			);

			// Assert
			expect(_mcpConfig).toHaveProperty("cyrus-tools");

			// Verify createCyrusToolsServer was called with correct options
			expect(createCyrusToolsServer).toHaveBeenCalledWith(
				expect.any(Object), // LinearClient from issueTracker.getClient()
				expect.objectContaining({
					parentSessionId,
					onFeedbackDelivery: expect.any(Function),
					onSessionCreated: expect.any(Function),
				}),
			);

			// Verify the callbacks were captured
			expect(mockOnFeedbackDelivery).toBeDefined();
			expect(mockOnSessionCreated).toBeDefined();
		});
	});
});
