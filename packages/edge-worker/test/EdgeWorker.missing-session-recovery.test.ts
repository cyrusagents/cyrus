import { join } from "node:path";
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

/**
 * Tests for CYPACK-852: Recover from missing session/repository mapping
 *
 * These tests verify that the EdgeWorker properly recovers when:
 * 1. A prompted webhook arrives but no issue->repository cache mapping exists
 * 2. A stop signal targets a session missing from in-memory managers
 * 3. An unassignment webhook arrives but no cached repository exists
 * 4. An issue update webhook arrives but no cached repository exists
 *
 * Currently, all these scenarios cause silent early returns, leaving the
 * Linear surface appearing stuck/hung with no user feedback.
 */
describe("EdgeWorker - Missing Session/Repository Recovery (CYPACK-852)", () => {
	let edgeWorker: EdgeWorker;
	let mockConfig: EdgeWorkerConfig;
	let mockAgentSessionManager: any;

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
		teamKeys: ["TEST"],
	};

	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});

		// Mock createCyrusToolsServer
		vi.mocked(createCyrusToolsServer).mockImplementation(() => {
			return { server: {} } as any;
		});

		// Mock ClaudeRunner
		vi.mocked(ClaudeRunner).mockImplementation(
			() =>
				({
					supportsStreamingInput: true,
					startStreaming: vi
						.fn()
						.mockResolvedValue({ sessionId: "claude-session-123" }),
					stop: vi.fn(),
					isStreaming: vi.fn().mockReturnValue(false),
					isRunning: vi.fn().mockReturnValue(false),
				}) as any,
		);

		// Mock AgentSessionManager with methods for recovery testing
		mockAgentSessionManager = {
			hasAgentRunner: vi.fn().mockReturnValue(false),
			getSession: vi.fn().mockReturnValue(null), // No session found (simulates missing session)
			getSessionsByIssueId: vi.fn().mockReturnValue([]),
			getActiveSessionsByIssueId: vi.fn().mockReturnValue([]),
			createCyrusAgentSession: vi.fn().mockReturnValue({
				id: "recovered-session",
				status: "active",
				issueContext: {
					trackerId: "linear",
					issueId: "issue-123",
					issueIdentifier: "TEST-123",
				},
				workspace: { path: "/test/workspaces/TEST-123", isGitWorktree: false },
			}),
			createResponseActivity: vi.fn().mockResolvedValue(undefined),
			postAnalyzingThought: vi.fn().mockResolvedValue(undefined),
			requestSessionStop: vi.fn(),
			setActivitySink: vi.fn(),
			on: vi.fn(),
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
					path: "/test/workspaces/TEST-123",
					isGitWorktree: false,
				}),
			},
		};

		edgeWorker = new EdgeWorker(mockConfig);

		// Set up repositories map
		(edgeWorker as any).repositories.set("test-repo", mockRepository);

		// Set up single agent session manager (but WITHOUT cached repository mappings)
		(edgeWorker as any).agentSessionManager = mockAgentSessionManager;

		// Mock issue tracker
		const mockIssueTracker = {
			getClient: vi.fn().mockReturnValue({}),
			fetchIssue: vi.fn().mockResolvedValue({
				id: "issue-123",
				identifier: "TEST-123",
				title: "Test Issue",
				description: "Test description",
				branchName: "test-123",
				team: { id: "test-workspace", key: "TEST", name: "Test Team" },
			}),
			fetchComment: vi.fn().mockResolvedValue(null),
		};
		(edgeWorker as any).issueTrackers.set("test-workspace", mockIssueTracker);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	// =========================================================================
	// Helper: Create a prompted webhook payload
	// =========================================================================
	function createPromptedWebhook(overrides: any = {}) {
		return {
			type: "AgentSessionEvent",
			action: "prompted",
			createdAt: new Date().toISOString(),
			organizationId: "test-workspace",
			agentSession: {
				id: "agent-session-legacy-123",
				issue: {
					id: "issue-123",
					identifier: "TEST-123",
					title: "Test Issue",
				},
				creator: {
					name: "Test User",
				},
				comment: {
					body: "Please continue working on this",
				},
				...overrides.agentSession,
			},
			agentActivity: {
				content: {
					body: "Please continue working on this",
				},
				sourceCommentId: "comment-123",
				...overrides.agentActivity,
			},
			...overrides,
		};
	}

	// =========================================================================
	// Helper: Create a stop signal webhook payload
	// =========================================================================
	function createStopSignalWebhook(overrides: any = {}) {
		return {
			type: "AgentSessionEvent",
			action: "prompted",
			createdAt: new Date().toISOString(),
			organizationId: "test-workspace",
			agentSession: {
				id: "agent-session-legacy-456",
				issue: {
					id: "issue-123",
					identifier: "TEST-123",
					title: "Test Issue",
				},
				creator: {
					name: "Test User",
				},
				...overrides.agentSession,
			},
			agentActivity: {
				signal: "stop",
				content: {
					body: "stop",
				},
				...overrides.agentActivity,
			},
			...overrides,
		};
	}

	// =========================================================================
	// Helper: Create an unassignment webhook payload
	// =========================================================================
	function createUnassignmentWebhook(overrides: any = {}) {
		return {
			type: "AppUserNotification",
			action: "issueUnassignedFromYou",
			createdAt: new Date().toISOString(),
			organizationId: "test-workspace",
			notification: {
				type: "issueUnassignedFromYou",
				id: "notification-789",
				issue: {
					id: "issue-123",
					identifier: "TEST-123",
					title: "Test Issue",
					teamId: "test-workspace",
					team: { id: "test-workspace", key: "TEST", name: "Test Team" },
				},
				actor: {
					id: "actor-789",
					name: "Test Unassigner",
				},
				...overrides.notification,
			},
			...overrides,
		};
	}

	// =========================================================================
	// Helper: Create an issue update webhook payload
	// =========================================================================
	function createIssueUpdateWebhook(overrides: any = {}) {
		return {
			type: "Issue",
			action: "update",
			createdAt: new Date().toISOString(),
			organizationId: "test-workspace",
			data: {
				id: "issue-123",
				identifier: "TEST-123",
				title: "Updated Title",
				description: "Updated description",
				...overrides.data,
			},
			updatedFrom: {
				title: "Old Title",
				...overrides.updatedFrom,
			},
			...overrides,
		};
	}

	// =========================================================================
	// 1. PROMPTED WEBHOOK — Missing repository cache mapping
	// =========================================================================
	describe("Prompted webhook with missing repository cache", () => {
		it("should attempt fallback repository resolution instead of returning silently", async () => {
			// Arrange: Ensure the issue-to-repository cache is EMPTY
			// (simulates post-restart/migration scenario)
			const repositoryRouter = (edgeWorker as any).repositoryRouter;
			const cache = repositoryRouter.getIssueRepositoryCache();
			cache.clear(); // No cached mappings

			const webhook = createPromptedWebhook();

			// Spy on the router's fallback resolution
			const determineRepoSpy = vi.spyOn(
				repositoryRouter,
				"determineRepositoryForWebhook",
			);

			// Act: Dispatch the webhook
			await (edgeWorker as any).handleWebhook(webhook, [mockRepository]);

			// Assert: Fallback resolution should have been attempted
			// Currently FAILS because the code returns early at line 3406
			expect(determineRepoSpy).toHaveBeenCalled();
		});

		it("should re-establish the repository cache mapping after fallback resolution", async () => {
			// Arrange: Empty cache
			const repositoryRouter = (edgeWorker as any).repositoryRouter;
			const cache = repositoryRouter.getIssueRepositoryCache();
			cache.clear();

			// Mock the fallback to return a valid repository (array format)
			vi.spyOn(
				repositoryRouter,
				"determineRepositoryForWebhook",
			).mockResolvedValue({
				type: "selected",
				repositories: [mockRepository],
				routingMethod: "team-based",
			});

			const webhook = createPromptedWebhook();

			// Act
			await (edgeWorker as any).handleWebhook(webhook, [mockRepository]);

			// Assert: Cache should now contain the mapping as string[]
			// Currently FAILS because fallback is never attempted
			expect(cache.get("issue-123")).toEqual(["test-repo"]);
		});

		it("should post a response activity when fallback resolution fails", async () => {
			// Arrange: Empty cache, and fallback returns no match
			const repositoryRouter = (edgeWorker as any).repositoryRouter;
			const cache = repositoryRouter.getIssueRepositoryCache();
			cache.clear();

			vi.spyOn(
				repositoryRouter,
				"determineRepositoryForWebhook",
			).mockResolvedValue({
				type: "none",
			});

			const webhook = createPromptedWebhook();

			// Act
			await (edgeWorker as any).handleWebhook(webhook, [mockRepository]);

			// Assert: Should NOT silently return — should post a visible response
			// Currently FAILS because the code returns early with just a log.warn
			// The user should see feedback that their prompt couldn't be processed
			expect(mockAgentSessionManager.createResponseActivity).toHaveBeenCalled();
		});
	});

	// =========================================================================
	// 2. STOP SIGNAL — Missing session from in-memory managers
	// =========================================================================
	describe("Stop signal with missing session", () => {
		it("should post a response activity instead of returning silently", async () => {
			// Arrange: No sessions exist in any manager (simulates post-restart)
			mockAgentSessionManager.getSession.mockReturnValue(null);

			const webhook = createStopSignalWebhook();

			// Act
			await (edgeWorker as any).handleWebhook(webhook, [mockRepository]);

			// Assert: Should post a response activity acknowledging the stop
			// Currently FAILS because handleStopSignal returns early at line 2999
			// with just log.warn("No session found for stop signal")
			expect(mockAgentSessionManager.createResponseActivity).toHaveBeenCalled();
		});

		it("should post a user-visible response when session cannot be found for stop signal", async () => {
			// Arrange: No sessions exist
			mockAgentSessionManager.getSession.mockReturnValue(null);

			const webhook = createStopSignalWebhook();

			// We need to verify that SOME activity is posted back to Linear
			// so the user doesn't see a hanging state.
			// Spy on any method that posts to Linear
			const postCommentSpy = vi
				.spyOn(edgeWorker as any, "postComment")
				.mockResolvedValue(undefined);

			// Act
			await (edgeWorker as any).handleWebhook(webhook, [mockRepository]);

			// Assert: Either createResponseActivity or postComment should be called
			// Currently FAILS — neither is called because of the silent early return
			const anyFeedbackPosted =
				mockAgentSessionManager.createResponseActivity.mock.calls.length > 0 ||
				postCommentSpy.mock.calls.length > 0;

			expect(anyFeedbackPosted).toBe(true);
		});
	});

	// =========================================================================
	// 3. UNASSIGNMENT — Missing repository cache mapping
	// =========================================================================
	describe("Unassignment webhook with missing repository cache", () => {
		it("should attempt to find and stop sessions across all managers", async () => {
			// Arrange: Empty repository cache but sessions exist in manager
			const repositoryRouter = (edgeWorker as any).repositoryRouter;
			const cache = repositoryRouter.getIssueRepositoryCache();
			cache.clear();

			// Simulate an active session for the issue
			const mockSession = {
				id: "agent-session-legacy-789",
				status: "active",
				repositories: [{ repositoryId: "test-repo" }],
				agentRunner: {
					stop: vi.fn(),
					isRunning: vi.fn().mockReturnValue(true),
				},
			};
			mockAgentSessionManager.getSessionsByIssueId.mockReturnValue([
				mockSession,
			]);

			const webhook = createUnassignmentWebhook();

			// Act
			await (edgeWorker as any).handleWebhook(webhook, [mockRepository]);

			// Assert: Should still find and stop sessions even without cached repo
			expect(mockAgentSessionManager.requestSessionStop).toHaveBeenCalled();
		});
	});

	// =========================================================================
	// 4. ISSUE UPDATE — Missing repository cache mapping
	// =========================================================================
	describe("Issue update webhook with missing repository cache", () => {
		it("should attempt fallback repository resolution for active sessions", async () => {
			// Arrange: Empty repository cache
			const repositoryRouter = (edgeWorker as any).repositoryRouter;
			const cache = repositoryRouter.getIssueRepositoryCache();
			cache.clear();

			const webhook = createIssueUpdateWebhook();

			// Spy on the router
			const determineRepoSpy = vi.spyOn(
				repositoryRouter,
				"determineRepositoryForWebhook",
			);

			// Act
			await (edgeWorker as any).handleWebhook(webhook, [mockRepository]);

			// Assert: Should attempt fallback resolution
			// Currently FAILS — handleIssueContentUpdate returns early at line 2212
			// For issue updates, at minimum the code should search all managers
			// for sessions matching the issue before giving up
			const searchedManagers =
				mockAgentSessionManager.getSessionsByIssueId.mock.calls.length > 0 ||
				determineRepoSpy.mock.calls.length > 0;

			expect(searchedManagers).toBe(true);
		});
	});

	// =========================================================================
	// 5. PROMPTED WEBHOOK — Missing session but repository IS cached
	//    (This scenario is already handled in handleNormalPromptedActivity,
	//     but we verify the recovery path works end-to-end)
	// =========================================================================
	describe("Prompted webhook with cached repository but missing session", () => {
		it("should create a replacement session and continue processing", async () => {
			// Arrange: Repository IS cached, but session is NOT found
			const repositoryRouter = (edgeWorker as any).repositoryRouter;
			const cache = repositoryRouter.getIssueRepositoryCache();
			cache.set("issue-123", ["test-repo"]);

			// Session not found initially
			mockAgentSessionManager.getSession.mockReturnValue(null);

			// Mock createCyrusAgentSession on EdgeWorker (the full method)
			const createSessionSpy = vi
				.spyOn(edgeWorker as any, "createCyrusAgentSession")
				.mockResolvedValue({
					session: {
						id: "agent-session-legacy-123",
						status: "active",
						workspace: {
							path: "/test/workspaces/TEST-123",
							isGitWorktree: false,
						},
						agentRunner: null,
					},
					fullIssue: {
						id: "issue-123",
						identifier: "TEST-123",
						title: "Test Issue",
					},
					workspace: {
						path: "/test/workspaces/TEST-123",
						isGitWorktree: false,
					},
					attachmentsDir: join(TEST_CYRUS_HOME, "TEST-123", "attachments"),
				});

			// Also mock the handlePromptWithStreamingCheck to prevent further execution
			vi.spyOn(
				edgeWorker as any,
				"handlePromptWithStreamingCheck",
			).mockResolvedValue(undefined);

			// Mock postInstantPromptedAcknowledgment
			vi.spyOn(
				edgeWorker as any,
				"postInstantPromptedAcknowledgment",
			).mockResolvedValue(undefined);

			const webhook = createPromptedWebhook();

			// Act
			await (edgeWorker as any).handleWebhook(webhook, [mockRepository]);

			// Assert: A new session should be created as replacement
			// This scenario is already handled by the existing code in
			// handleNormalPromptedActivity, but this test verifies the full path
			expect(createSessionSpy).toHaveBeenCalledWith(
				"agent-session-legacy-123",
				expect.objectContaining({ id: "issue-123" }),
				[mockRepository],
				mockAgentSessionManager,
				"test-workspace",
			);
		});
	});
});
