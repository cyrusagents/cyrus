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
		PersistenceManager: vi.fn().mockImplementation(function () {
			return {
				loadEdgeWorkerState: vi.fn().mockResolvedValue(null),
				saveEdgeWorkerState: vi.fn().mockResolvedValue(undefined),
			};
		}),
	};
});

/**
 * Tests for CYPACK-954: Issue update webhook delivery
 *
 * Issue update events (title/description changes) are ONLY delivered to
 * currently running sessions via streaming. If no session is running or
 * the runner doesn't support streaming, the event is ignored. Duplicate
 * webhooks are deduplicated by createdAt+issueId key.
 */
describe("EdgeWorker - Issue Update Session Delivery (CYPACK-954)", () => {
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

	// Helper: Create mock sessions for the same issue
	function createMockSession(
		id: string,
		opts: {
			isRunning?: boolean;
			supportsStreaming?: boolean;
			hasRunner?: boolean;
		} = {},
	) {
		const {
			isRunning = false,
			supportsStreaming = true,
			hasRunner = false,
		} = opts;

		return {
			id,
			status: "active",
			issueContext: {
				trackerId: "linear",
				issueId: "issue-123",
				issueIdentifier: "TEST-123",
			},
			workspace: { path: "/test/workspaces/TEST-123", isGitWorktree: false },
			claudeSessionId: `claude-session-for-${id}`,
			agentRunner: hasRunner
				? {
						isRunning: vi.fn().mockReturnValue(isRunning),
						supportsStreamingInput: supportsStreaming,
						addStreamMessage: vi.fn(),
						stop: vi.fn(),
					}
				: null,
			updatedAt: Date.now(),
		};
	}

	// Helper: Create an issue update webhook payload
	function createIssueUpdateWebhook(overrides: any = {}) {
		return {
			type: "Issue",
			action: "update",
			createdAt: overrides.createdAt ?? new Date().toISOString(),
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

	function cacheRepository() {
		const cache = (
			edgeWorker as any
		).repositoryRouter.getIssueRepositoryCache();
		cache.set("issue-123", ["test-repo"]);
	}

	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});

		vi.mocked(createCyrusToolsServer).mockImplementation(() => {
			return { server: {} } as any;
		});

		vi.mocked(ClaudeRunner).mockImplementation(function () {
			return {
				supportsStreamingInput: true,
				startStreaming: vi
					.fn()
					.mockResolvedValue({ sessionId: "claude-session-123" }),
				stop: vi.fn(),
				isStreaming: vi.fn().mockReturnValue(false),
				isRunning: vi.fn().mockReturnValue(false),
			};
		} as any);

		mockAgentSessionManager = {
			hasAgentRunner: vi.fn().mockReturnValue(false),
			getSession: vi.fn().mockReturnValue(null),
			getSessionsByIssueId: vi.fn().mockReturnValue([]),
			getActiveSessionsByIssueId: vi.fn().mockReturnValue([]),
			createCyrusAgentSession: vi.fn(),
			createResponseActivity: vi.fn().mockResolvedValue(undefined),
			postAnalyzingThought: vi.fn().mockResolvedValue(undefined),
			requestSessionStop: vi.fn(),
			setActivitySink: vi.fn(),
			addAgentRunner: vi.fn(),
			on: vi.fn(),
		};

		vi.mocked(AgentSessionManager).mockImplementation(function () {
			return mockAgentSessionManager;
		});

		vi.mocked(SharedApplicationServer).mockImplementation(function () {
			return {
				start: vi.fn().mockResolvedValue(undefined),
				stop: vi.fn().mockResolvedValue(undefined),
				getFastifyInstance: vi.fn().mockReturnValue({ post: vi.fn() }),
				getWebhookUrl: vi.fn().mockReturnValue("http://localhost:3456/webhook"),
				registerOAuthCallbackHandler: vi.fn(),
			};
		} as any);

		vi.mocked(LinearEventTransport).mockImplementation(function () {
			return {
				register: vi.fn(),
				on: vi.fn(),
				removeAllListeners: vi.fn(),
			};
		} as any);

		vi.mocked(LinearClient).mockImplementation(function () {
			return {
				users: {
					me: vi.fn().mockResolvedValue({
						id: "user-123",
						name: "Test User",
					}),
				},
			};
		} as any);

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

		// Set up the agent session manager
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
		vi.unstubAllEnvs();
	});

	describe("per-user ownership of active issue-update inputs", () => {
		function configureOwnership(policy: "reject" | "pin") {
			vi.stubEnv("UPDATE_ADA_CLAUDE", "placeholder-claude");
			vi.stubEnv("UPDATE_ADA_GITHUB", "placeholder-github");
			(edgeWorker as any).prompterCredentialService.updateConfig({
				linearUsers: {
					ada: {
						displayName: "Ada",
						claude: { oauthToken: { env: "UPDATE_ADA_CLAUDE" } },
						github: { token: { env: "UPDATE_ADA_GITHUB" }, login: "ada" },
					},
					bob: {
						displayName: "Bob",
						claude: { oauthToken: { env: "UPDATE_ADA_CLAUDE" } },
						github: { token: { env: "UPDATE_ADA_GITHUB" }, login: "bob" },
					},
				},
				prompterCredentialPolicy: { followUpByOtherUser: policy },
			});
		}

		const cases = (["reject", "pin"] as const).flatMap((policy) =>
			(["same", "other", "missing", "integration"] as const).flatMap((actor) =>
				(["title", "description"] as const).map((field) => ({
					policy,
					actor,
					field,
				})),
			),
		);

		it.each(cases)("$field update from $actor actor under $policy", async ({
			policy,
			actor,
			field,
		}) => {
			configureOwnership(policy);
			const running = {
				...createMockSession("session-ada", {
					hasRunner: true,
					isRunning: true,
				}),
				prompter: {
					linearUserId: "ada",
					credentialUserId: "ada",
					source: "prompter",
				},
			};
			mockAgentSessionManager.getSessionsByIssueId.mockReturnValue([running]);
			cacheRepository();
			const postActivity = vi
				.spyOn(edgeWorker as any, "postActivityDirect")
				.mockResolvedValue(undefined);
			const postThought = vi
				.spyOn((edgeWorker as any).activityPoster, "postThoughtActivity")
				.mockResolvedValue(undefined);
			const download = vi
				.spyOn(edgeWorker as any, "downloadCommentAttachments")
				.mockResolvedValue({ totalNewAttachments: 0 });
			const webhook = createIssueUpdateWebhook({
				updatedFrom: { [field]: "old content" },
			});
			// The creator and assignee are Ada even when Bob edited or the actor is absent.
			webhook.data.creatorId = "ada";
			webhook.data.creator = { id: "ada", name: "Ada" };
			webhook.data.assigneeId = "ada";
			if (actor !== "missing")
				webhook.actor = {
					id: actor === "same" || actor === "integration" ? "ada" : "bob",
					name: actor === "same" ? "Ada" : "Bob",
					type: actor === "integration" ? "integration" : "user",
				};
			await (edgeWorker as any).handleIssueContentUpdate(webhook);
			if (policy === "reject" && actor !== "same") {
				expect(running.agentRunner!.addStreamMessage).not.toHaveBeenCalled();
				expect(download).not.toHaveBeenCalled();
				expect(postActivity).toHaveBeenCalledWith(
					expect.anything(),
					expect.objectContaining({
						agentSessionId: running.id,
						content: {
							type: "response",
							body: expect.stringContaining(
								actor === "other" ? "Bob" : "could not determine",
							),
						},
					}),
					expect.any(String),
				);
			} else {
				expect(postActivity).not.toHaveBeenCalled();
				expect(
					running.agentRunner!.addStreamMessage,
				).toHaveBeenCalledExactlyOnceWith(
					expect.stringContaining(`<${field}_change>`),
				);
				if (actor !== "same")
					expect(postThought).toHaveBeenCalledWith(
						running.id,
						"test-workspace",
						expect.stringContaining("Ada"),
					);
			}
			expect(running.prompter.credentialUserId).toBe("ada");
		});
		it.each([
			"removed",
			"unpinned",
		] as const)("refuses an active %s owner without switching credentials", async (state) => {
			configureOwnership("reject");
			const running = {
				...createMockSession("session-ada", {
					hasRunner: true,
					isRunning: true,
				}),
				prompter:
					state === "removed"
						? {
								linearUserId: "ada",
								credentialUserId: "ada",
								source: "prompter",
							}
						: undefined,
			};
			if (state === "removed")
				(edgeWorker as any).prompterCredentialService.updateConfig({
					linearUsers: {},
				});
			mockAgentSessionManager.getSessionsByIssueId.mockReturnValue([running]);
			cacheRepository();
			const postActivity = vi
				.spyOn(edgeWorker as any, "postActivityDirect")
				.mockResolvedValue(undefined);
			await (edgeWorker as any).handleIssueContentUpdate(
				createIssueUpdateWebhook({
					actor: { id: "ada", name: "Ada", type: "user" },
				}),
			);
			expect(running.agentRunner!.addStreamMessage).not.toHaveBeenCalled();
			expect(postActivity).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({
					agentSessionId: running.id,
					content: {
						type: "response",
						body: expect.stringContaining(
							state === "removed" ? "no entry" : "no assigned credential owner",
						),
					},
				}),
				expect.any(String),
			);
			if (state === "unpinned") expect(running.prompter).toBeUndefined();
		});

		it("does not redirect a refused update to another active session", async () => {
			configureOwnership("reject");
			const running = ["ada", "bob"].map((owner, index) => ({
				...createMockSession(`session-${owner}`, {
					hasRunner: true,
					isRunning: true,
				}),
				updatedAt: 100 - index,
				prompter: {
					linearUserId: owner,
					credentialUserId: owner,
					source: "prompter",
				},
			}));
			mockAgentSessionManager.getSessionsByIssueId.mockReturnValue(running);
			cacheRepository();
			vi.spyOn(edgeWorker as any, "postActivityDirect").mockResolvedValue(
				undefined,
			);
			await (edgeWorker as any).handleIssueContentUpdate(
				createIssueUpdateWebhook({
					actor: { id: "bob", name: "Bob", type: "user" },
				}),
			);
			for (const session of running)
				expect(session.agentRunner!.addStreamMessage).not.toHaveBeenCalled();
		});
	});

	// =========================================================================
	// Streaming-only delivery
	// =========================================================================

	describe("Streaming-only delivery", () => {
		it("should stream update to a running session with streaming support", async () => {
			const runningSession = createMockSession("session-running", {
				hasRunner: true,
				isRunning: true,
				supportsStreaming: true,
			});

			mockAgentSessionManager.getSessionsByIssueId.mockReturnValue([
				runningSession,
			]);
			cacheRepository();

			await (edgeWorker as any).handleIssueContentUpdate(
				createIssueUpdateWebhook(),
			);

			expect(
				runningSession.agentRunner!.addStreamMessage,
			).toHaveBeenCalledTimes(1);
		});

		it("should NOT resume idle sessions — updates are streaming-only", async () => {
			const idleSession = createMockSession("session-idle");

			mockAgentSessionManager.getSessionsByIssueId.mockReturnValue([
				idleSession,
			]);
			cacheRepository();

			const handlePromptSpy = vi
				.spyOn(edgeWorker as any, "handlePromptWithStreamingCheck")
				.mockResolvedValue(false);

			await (edgeWorker as any).handleIssueContentUpdate(
				createIssueUpdateWebhook(),
			);

			// Idle sessions should never be resumed for issue updates
			expect(handlePromptSpy).toHaveBeenCalledTimes(0);
		});

		it("should ignore running sessions that do not support streaming", async () => {
			const nonStreamingSession = createMockSession("session-no-streaming", {
				hasRunner: true,
				isRunning: true,
				supportsStreaming: false,
			});

			mockAgentSessionManager.getSessionsByIssueId.mockReturnValue([
				nonStreamingSession,
			]);
			cacheRepository();

			await (edgeWorker as any).handleIssueContentUpdate(
				createIssueUpdateWebhook(),
			);

			// Runner doesn't support streaming — addStreamMessage should NOT be called
			expect(
				nonStreamingSession.agentRunner!.addStreamMessage,
			).not.toHaveBeenCalled();
		});

		it("should stream only to the most recently updated running session", async () => {
			const olderRunning = {
				...createMockSession("session-r1", {
					hasRunner: true,
					isRunning: true,
					supportsStreaming: true,
				}),
				updatedAt: Date.now() - 60000,
			};
			const newerRunning = {
				...createMockSession("session-r2", {
					hasRunner: true,
					isRunning: true,
					supportsStreaming: true,
				}),
				updatedAt: Date.now(),
			};

			mockAgentSessionManager.getSessionsByIssueId.mockReturnValue([
				olderRunning,
				newerRunning,
			]);
			cacheRepository();

			await (edgeWorker as any).handleIssueContentUpdate(
				createIssueUpdateWebhook(),
			);

			// Only the most recently updated session should receive the stream
			expect(newerRunning.agentRunner!.addStreamMessage).toHaveBeenCalledTimes(
				1,
			);
			expect(olderRunning.agentRunner!.addStreamMessage).not.toHaveBeenCalled();
		});

		it("should NOT resume idle sessions even when a running session receives the stream", async () => {
			const runningSession = createMockSession("session-running", {
				hasRunner: true,
				isRunning: true,
				supportsStreaming: true,
			});
			const idleSession = createMockSession("session-idle");

			mockAgentSessionManager.getSessionsByIssueId.mockReturnValue([
				runningSession,
				idleSession,
			]);
			cacheRepository();

			const handlePromptSpy = vi
				.spyOn(edgeWorker as any, "handlePromptWithStreamingCheck")
				.mockResolvedValue(false);

			await (edgeWorker as any).handleIssueContentUpdate(
				createIssueUpdateWebhook(),
			);

			// Running session gets the stream
			expect(
				runningSession.agentRunner!.addStreamMessage,
			).toHaveBeenCalledTimes(1);
			// Idle session is NOT resumed
			expect(handlePromptSpy).toHaveBeenCalledTimes(0);
		});
	});

	// =========================================================================
	// Webhook deduplication
	// =========================================================================

	describe("Webhook deduplication", () => {
		it("should ignore duplicate webhooks with the same createdAt and issueId", async () => {
			const runningSession = createMockSession("session-running", {
				hasRunner: true,
				isRunning: true,
				supportsStreaming: true,
			});

			mockAgentSessionManager.getSessionsByIssueId.mockReturnValue([
				runningSession,
			]);
			cacheRepository();

			const webhook = createIssueUpdateWebhook({
				createdAt: "2026-03-13T12:00:00.000Z",
			});

			// First delivery
			await (edgeWorker as any).handleIssueContentUpdate(webhook);
			// Duplicate delivery
			await (edgeWorker as any).handleIssueContentUpdate(webhook);

			// Should only be streamed once
			expect(
				runningSession.agentRunner!.addStreamMessage,
			).toHaveBeenCalledTimes(1);
		});

		it("should process webhooks with different createdAt as separate events", async () => {
			const runningSession = createMockSession("session-running", {
				hasRunner: true,
				isRunning: true,
				supportsStreaming: true,
			});

			mockAgentSessionManager.getSessionsByIssueId.mockReturnValue([
				runningSession,
			]);
			cacheRepository();

			const webhook1 = createIssueUpdateWebhook({
				createdAt: "2026-03-13T12:00:00.000Z",
			});
			const webhook2 = createIssueUpdateWebhook({
				createdAt: "2026-03-13T12:01:00.000Z",
			});

			await (edgeWorker as any).handleIssueContentUpdate(webhook1);
			await (edgeWorker as any).handleIssueContentUpdate(webhook2);

			// Both should be streamed (different events)
			expect(
				runningSession.agentRunner!.addStreamMessage,
			).toHaveBeenCalledTimes(2);
		});
	});
});
