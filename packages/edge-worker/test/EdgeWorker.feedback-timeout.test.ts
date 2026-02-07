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

describe("EdgeWorker - Feedback Delivery Timeout Issue", () => {
	let edgeWorker: EdgeWorker;
	let mockConfig: EdgeWorkerConfig;
	let mockAgentSessionManager: any;
	let mockChildAgentSessionManager: any;
	let mockClaudeRunner: any;
	let resumeClaudeSessionSpy: any;
	let mockOnFeedbackDelivery: any;
	let _mockOnSessionCreated: any;

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
		_mockOnSessionCreated = vi.fn();

		// Mock createCyrusToolsServer to return a proper structure
		vi.mocked(createCyrusToolsServer).mockImplementation((_token, options) => {
			// Capture the callbacks
			if (options?.onFeedbackDelivery) {
				mockOnFeedbackDelivery = options.onFeedbackDelivery;
			}
			if (options?.onSessionCreated) {
				_mockOnSessionCreated = options.onSessionCreated;
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

		// Mock ClaudeRunner with a long-running session to simulate the timeout
		mockClaudeRunner = {
			supportsStreamingInput: true,
			startStreaming: vi.fn().mockImplementation(async () => {
				// Simulate a long-running Claude session (10 seconds)
				await new Promise((resolve) => setTimeout(resolve, 10000));
				return { sessionId: "claude-session-123" };
			}),
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
		vi.useRealTimers();
	});

	describe("Feedback Delivery Timeout Fix", () => {
		it("FIXED: should return immediately without waiting for child session to complete", async () => {
			// This test verifies the fix: feedback delivery returns immediately
			// without waiting for the child session to complete

			// Arrange
			const childSessionId = "child-session-456";
			const feedbackMessage =
				"Please revise your approach and focus on the error handling";

			// Use the real implementation without mocking resumeAgentSession
			// to test the actual fire-and-forget behavior
			resumeClaudeSessionSpy = vi
				.spyOn(edgeWorker as any, "resumeAgentSession")
				.mockImplementation(async () => {
					// Simulate a long-running session
					await mockClaudeRunner.startStreaming();
					return undefined;
				});

			// Build MCP config which will trigger createCyrusToolsServer
			const _mcpConfig = (edgeWorker as any).buildMcpConfig(
				mockRepository,
				"parent-session-123",
			);

			// Act - Call the feedback delivery and measure time
			const startTime = Date.now();
			const result = await mockOnFeedbackDelivery(
				childSessionId,
				feedbackMessage,
			);
			const endTime = Date.now();
			const duration = endTime - startTime;

			// Assert - The feedback delivery should return quickly
			expect(result).toBe(true);

			// Wait for the async handlePromptWithStreamingCheck to complete (fire-and-forget pattern)
			await new Promise((resolve) => setTimeout(resolve, 100));

			expect(resumeClaudeSessionSpy).toHaveBeenCalledOnce();

			// Should return in less than 100ms (not wait for the 10-second session)
			expect(duration).toBeLessThan(100);

			// The child session is still running in the background
			expect(mockClaudeRunner.startStreaming).toHaveBeenCalledOnce();
		}); // Regular timeout since it should return quickly

		it("should verify feedback initiates session but doesn't block on completion", async () => {
			// This test verifies the fire-and-forget behavior

			// Arrange
			const childSessionId = "child-session-456";
			const feedbackMessage = "Test feedback";
			let sessionCompleted = false;

			// Mock resumeAgentSession to track when it completes
			resumeClaudeSessionSpy = vi
				.spyOn(edgeWorker as any, "resumeAgentSession")
				.mockImplementation(async () => {
					// Start a 2-second operation
					await new Promise((resolve) => setTimeout(resolve, 2000));
					sessionCompleted = true;
					return undefined;
				});

			// Build MCP config
			const _mcpConfig = (edgeWorker as any).buildMcpConfig(
				mockRepository,
				"parent-session-123",
			);

			// Act
			const startTime = Date.now();
			const result = await mockOnFeedbackDelivery(
				childSessionId,
				feedbackMessage,
			);
			const duration = Date.now() - startTime;

			// Assert
			expect(result).toBe(true);
			expect(duration).toBeLessThan(100); // Returns immediately
			expect(sessionCompleted).toBe(false); // Session still running

			// Wait for the async handlePromptWithStreamingCheck to complete (fire-and-forget pattern)
			await new Promise((resolve) => setTimeout(resolve, 100));

			expect(resumeClaudeSessionSpy).toHaveBeenCalledOnce();

			// Wait a bit and verify session completes in background
			await new Promise((resolve) => setTimeout(resolve, 2100));
			expect(sessionCompleted).toBe(true);
		}, 5000);
	});
});
