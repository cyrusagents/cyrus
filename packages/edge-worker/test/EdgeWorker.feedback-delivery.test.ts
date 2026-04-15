import { LinearClient } from "@linear/sdk";
import { ClaudeRunner } from "cyrus-claude-runner";
import { LinearEventTransport } from "cyrus-linear-event-transport";
import { createCyrusToolsServer } from "cyrus-mcp-tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager.js";
import { EdgeWorker } from "../src/EdgeWorker.js";
import { SharedApplicationServer } from "../src/SharedApplicationServer.js";
import type { EdgeWorkerConfig, RepositoryConfig } from "../src/types.js";
import { TEST_CYRUS_HOME } from "./test-dirs.js";

// Mock all dependencies
vi.mock("fs/promises");
vi.mock("cyrus-claude-runner");
vi.mock("cyrus-mcp-tools");
vi.mock("cyrus-codex-runner");
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
		vi.mocked(createCyrusToolsServer).mockImplementation((_client, options) => {
			// Capture the callbacks
			if (options?.onFeedbackDelivery) {
				mockOnFeedbackDelivery = options.onFeedbackDelivery;
			}
			if (options?.onSessionCreated) {
				mockOnSessionCreated = options.onSessionCreated;
			}

			// Return a mock MCP server shape
			return {
				server: {},
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
			createThoughtActivity: vi.fn().mockResolvedValue(undefined),
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
			cyrusHome: TEST_CYRUS_HOME,
			repositories: [mockRepository],
			linearWorkspaces: {
				"test-workspace": { linearToken: "test-token" },
			},
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

		// Setup parent-child mapping in GlobalSessionRegistry (single source of truth)
		(edgeWorker as any).globalSessionRegistry.setParentSession(
			"child-session-456",
			"parent-session-123",
		);

		// Setup single agent session manager and session-to-repo mapping
		(edgeWorker as any).agentSessionManager = mockChildAgentSessionManager;
		(edgeWorker as any).sessionRepositories.set(
			"child-session-456",
			"test-repo",
		);
		(edgeWorker as any).repositories.set("test-repo", mockRepository);

		// Inject mock issue tracker for the test workspace
		(edgeWorker as any).issueTrackers.set(mockRepository.linearWorkspaceId, {
			fetchIssue: vi.fn(),
			getIssueLabels: vi.fn().mockResolvedValue([]),
			getClient: vi.fn().mockReturnValue({}),
		});
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
			const _mcpConfig = (edgeWorker as any).mcpConfigService.buildMcpConfig(
				mockRepository.id,
				mockRepository.linearWorkspaceId,
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
			// Arrange - Replace registry with a fresh one (no parent mapping)
			const { GlobalSessionRegistry } = await import(
				"../src/GlobalSessionRegistry.js"
			);
			(edgeWorker as any).globalSessionRegistry = new GlobalSessionRegistry();

			const childSessionId = "child-session-456";
			const feedbackMessage = "Test feedback without known parent";

			// Build MCP config which will trigger createCyrusToolsServer
			const _mcpConfig = (edgeWorker as any).mcpConfigService.buildMcpConfig(
				mockRepository.id,
				mockRepository.linearWorkspaceId,
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
			const _mcpConfig = (edgeWorker as any).mcpConfigService.buildMcpConfig(
				mockRepository.id,
				mockRepository.linearWorkspaceId,
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
				expect.stringContaining(
					`Child session ${childSessionId} not found in any repository`,
				),
			);
		});

		it("should return false when child session data is not found in manager", async () => {
			// Arrange
			mockChildAgentSessionManager.getSession.mockReturnValue(null);

			const childSessionId = "child-session-456";
			const feedbackMessage = "This should also fail";

			// Build MCP config which will trigger createCyrusToolsServer
			const _mcpConfig = (edgeWorker as any).mcpConfigService.buildMcpConfig(
				mockRepository.id,
				mockRepository.linearWorkspaceId,
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
				expect.stringContaining(`Child session ${childSessionId} not found`),
			);
		});

		it("should handle resumeAgentSession errors gracefully", async () => {
			// Arrange
			resumeAgentSessionSpy.mockRejectedValue(new Error("Resume failed"));

			const childSessionId = "child-session-456";
			const feedbackMessage = "This will cause resume to fail";

			// Build MCP config which will trigger createCyrusToolsServer
			const _mcpConfig = (edgeWorker as any).mcpConfigService.buildMcpConfig(
				mockRepository.id,
				mockRepository.linearWorkspaceId,
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
				expect.stringContaining(`Failed to process feedback in child session:`),
				expect.any(Error),
			);
		});

		it("should find child session via single session manager and sessionRepositories mapping", async () => {
			// Arrange - The single ASM has the child session runner
			mockChildAgentSessionManager.hasAgentRunner.mockReturnValue(true);

			const childSessionId = "child-session-456";
			const feedbackMessage = "Test feedback across repositories";

			// Build MCP config which will trigger createCyrusToolsServer
			const _mcpConfig = (edgeWorker as any).mcpConfigService.buildMcpConfig(
				mockRepository.id,
				mockRepository.linearWorkspaceId,
				"parent-session-123",
			);

			// Act - Call the captured feedback delivery callback
			const result = await mockOnFeedbackDelivery(
				childSessionId,
				feedbackMessage,
			);

			// Assert - Should find the child via sessionRepositories and single ASM
			expect(result).toBe(true);

			// Wait for the async handlePromptWithStreamingCheck to complete (fire-and-forget pattern)
			await new Promise((resolve) => setTimeout(resolve, 100));

			expect(resumeAgentSessionSpy).toHaveBeenCalledOnce();

			// Verify the child was found via the single session manager
			expect(mockChildAgentSessionManager.hasAgentRunner).toHaveBeenCalledWith(
				childSessionId,
			);
		});
	});

	describe("Integration with cyrus-tools server", () => {
		it("should properly configure feedback delivery callback in MCP config", () => {
			// Arrange
			const parentSessionId = "parent-session-123";

			// Act
			const _mcpConfig = (edgeWorker as any).mcpConfigService.buildMcpConfig(
				mockRepository.id,
				mockRepository.linearWorkspaceId,
				parentSessionId,
			);

			// Assert
			expect(_mcpConfig).toHaveProperty("cyrus-tools");

			// Verify createCyrusToolsServer was called with correct options
			expect(createCyrusToolsServer).toHaveBeenCalledWith(
				expect.any(Object),
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

		it("should include CYRUS_API_KEY as Authorization header for cyrus-tools MCP config", () => {
			const previousApiKey = process.env.CYRUS_API_KEY;
			process.env.CYRUS_API_KEY = "test-cyrus-api-key";

			try {
				const mcpConfig = (edgeWorker as any).mcpConfigService.buildMcpConfig(
					mockRepository.id,
					mockRepository.linearWorkspaceId,
					"parent-session-123",
				);
				const cyrusToolsConfig = mcpConfig["cyrus-tools"] as {
					headers?: Record<string, string>;
				};

				expect(cyrusToolsConfig.headers?.Authorization).toBe(
					"Bearer test-cyrus-api-key",
				);
			} finally {
				if (previousApiKey === undefined) {
					delete process.env.CYRUS_API_KEY;
				} else {
					process.env.CYRUS_API_KEY = previousApiKey;
				}
			}
		});

		it("should validate cyrus-tools MCP Authorization header against CYRUS_API_KEY", () => {
			const previousApiKey = process.env.CYRUS_API_KEY;
			process.env.CYRUS_API_KEY = "test-cyrus-api-key";

			try {
				expect(
					(edgeWorker as any).mcpConfigService.isAuthorizationValid(
						"Bearer test-cyrus-api-key",
					),
				).toBe(true);
				expect(
					(edgeWorker as any).mcpConfigService.isAuthorizationValid(
						"Bearer wrong-key",
					),
				).toBe(false);
				expect(
					(edgeWorker as any).mcpConfigService.isAuthorizationValid(undefined),
				).toBe(false);
			} finally {
				if (previousApiKey === undefined) {
					delete process.env.CYRUS_API_KEY;
				} else {
					process.env.CYRUS_API_KEY = previousApiKey;
				}
			}
		});
	});

	describe("Child Session Mapping (single source of truth in GlobalSessionRegistry)", () => {
		it("should register parent-child mapping in GlobalSessionRegistry when handleChildSessionMapping is called", () => {
			const childId = "new-child-session-789";
			const parentId = "parent-session-123";

			// Call handleChildSessionMapping
			(edgeWorker as any).handleChildSessionMapping(childId, parentId);

			// Verify it's in GlobalSessionRegistry (single source of truth - CYPACK-922)
			const globalRegistry = (edgeWorker as any).globalSessionRegistry;
			expect(globalRegistry.getParentSessionId(childId)).toBe(parentId);
		});

		it("should allow AgentSessionManager getParentSessionId callback to find the mapping", () => {
			const childId = "callback-child-session";
			const parentId = "callback-parent-session";

			// Simulate what happens when a child session is created via MCP tool
			(edgeWorker as any).handleChildSessionMapping(childId, parentId);

			// The AgentSessionManager callback reads from globalSessionRegistry
			const globalRegistry = (edgeWorker as any).globalSessionRegistry;
			const result = globalRegistry.getParentSessionId(childId);

			expect(result).toBe(parentId);
		});
	});
});
