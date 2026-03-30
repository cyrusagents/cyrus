import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EdgeWorker } from "../src/EdgeWorker.js";
import type { EdgeWorkerConfig, RepositoryConfig } from "../src/types.js";

// Mock fs/promises
vi.mock("fs/promises", () => ({
	readFile: vi.fn(),
	writeFile: vi.fn(),
	mkdir: vi.fn(),
	rename: vi.fn(),
	readdir: vi.fn().mockResolvedValue([]),
}));

// Mock dependencies
vi.mock("cyrus-claude-runner");
vi.mock("cyrus-codex-runner");
vi.mock("cyrus-gemini-runner");
vi.mock("cyrus-linear-event-transport");
vi.mock("@linear/sdk");
vi.mock("../src/SharedApplicationServer.js", () => ({
	SharedApplicationServer: vi.fn().mockImplementation(() => ({
		initializeFastify: vi.fn(),
		getFastifyInstance: vi.fn().mockReturnValue({
			get: vi.fn(),
			post: vi.fn(),
		}),
		start: vi.fn().mockResolvedValue(undefined),
		stop: vi.fn().mockResolvedValue(undefined),
		getWebhookUrl: vi.fn().mockReturnValue("http://localhost:3456/webhook"),
	})),
}));
vi.mock("../src/AgentSessionManager.js", () => ({
	AgentSessionManager: vi.fn().mockImplementation(() => ({
		getAllAgentRunners: vi.fn().mockReturnValue([]),
		getAllSessions: vi.fn().mockReturnValue([]),
		getActiveSessions: vi.fn().mockReturnValue([]),
		createCyrusAgentSession: vi.fn(),
		getSession: vi.fn(),
		getActiveSessionsByIssueId: vi.fn().mockReturnValue([]),
		setActivitySink: vi.fn(),
		on: vi.fn(),
		emit: vi.fn(),
	})),
}));
vi.mock("cyrus-core", async (importOriginal) => {
	const actual = (await importOriginal()) as any;
	return {
		...actual,
		isAgentSessionCreatedWebhook: vi.fn().mockReturnValue(false),
		isAgentSessionPromptedWebhook: vi.fn().mockReturnValue(false),
		isIssueAssignedWebhook: vi.fn().mockReturnValue(false),
		isIssueCommentMentionWebhook: vi.fn().mockReturnValue(false),
		isIssueNewCommentWebhook: vi.fn().mockReturnValue(false),
		isIssueUnassignedWebhook: vi.fn().mockReturnValue(false),
		PersistenceManager: vi.fn().mockImplementation(() => ({
			loadEdgeWorkerState: vi.fn().mockResolvedValue(null),
			saveEdgeWorkerState: vi.fn().mockResolvedValue(undefined),
		})),
	};
});
vi.mock("file-type");
vi.mock("chokidar", () => ({
	watch: vi.fn().mockReturnValue({
		on: vi.fn().mockReturnThis(),
		close: vi.fn().mockResolvedValue(undefined),
	}),
}));

describe("EdgeWorker - Health Endpoint", () => {
	let edgeWorker: EdgeWorker;
	let mockConfig: EdgeWorkerConfig;

	const mockRepository: RepositoryConfig = {
		id: "test-repo",
		name: "Test Repo",
		repositoryPath: "/test/repo",
		workspaceBaseDir: "/test/workspaces",
		baseBranch: "main",
		linearWorkspaceId: "test-workspace",
		isActive: true,
	};

	beforeEach(() => {
		vi.clearAllMocks();

		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});

		mockConfig = {
			platform: "linear",
			cyrusHome: "/test/.cyrus",
			repositories: [mockRepository],
			linearWorkspaces: {
				"test-workspace": { linearToken: "test-token" },
			},
		};
	});

	afterEach(async () => {
		if (edgeWorker) {
			try {
				await edgeWorker.stop();
			} catch {
				// Ignore cleanup errors
			}
		}
	});

	describe("registerHealthEndpoint", () => {
		it("should register GET /health endpoint with Fastify", async () => {
			const mockGet = vi.fn();
			const mockFastify = { get: mockGet, post: vi.fn() };

			const { SharedApplicationServer } = await import(
				"../src/SharedApplicationServer.js"
			);
			vi.mocked(SharedApplicationServer).mockImplementation(
				() =>
					({
						initializeFastify: vi.fn(),
						getFastifyInstance: vi.fn().mockReturnValue(mockFastify),
						start: vi.fn().mockResolvedValue(undefined),
						stop: vi.fn().mockResolvedValue(undefined),
						getWebhookUrl: vi
							.fn()
							.mockReturnValue("http://localhost:3456/webhook"),
					}) as any,
			);

			edgeWorker = new EdgeWorker(mockConfig);
			(edgeWorker as any).registerHealthEndpoint();

			expect(mockGet).toHaveBeenCalledWith("/health", expect.any(Function));
		});

		it("should return healthy status with no active sessions", async () => {
			let capturedHandler: any = null;
			const mockGet = vi.fn((path: string, handler: any) => {
				if (path === "/health") {
					capturedHandler = handler;
				}
			});
			const mockFastify = { get: mockGet, post: vi.fn() };

			const { SharedApplicationServer } = await import(
				"../src/SharedApplicationServer.js"
			);
			vi.mocked(SharedApplicationServer).mockImplementation(
				() =>
					({
						initializeFastify: vi.fn(),
						getFastifyInstance: vi.fn().mockReturnValue(mockFastify),
						start: vi.fn().mockResolvedValue(undefined),
						stop: vi.fn().mockResolvedValue(undefined),
						getWebhookUrl: vi
							.fn()
							.mockReturnValue("http://localhost:3456/webhook"),
					}) as any,
			);

			const { AgentSessionManager } = await import(
				"../src/AgentSessionManager.js"
			);
			vi.mocked(AgentSessionManager).mockImplementation(
				() =>
					({
						getAllAgentRunners: vi.fn().mockReturnValue([]),
						getAllSessions: vi.fn().mockReturnValue([]),
						getActiveSessions: vi.fn().mockReturnValue([]),
						createCyrusAgentSession: vi.fn(),
						getSession: vi.fn(),
						getActiveSessionsByIssueId: vi.fn().mockReturnValue([]),
						setActivitySink: vi.fn(),
						on: vi.fn(),
						emit: vi.fn(),
					}) as any,
			);

			const configWithVersion: EdgeWorkerConfig = {
				...mockConfig,
				version: "2.0.0",
				claudeDefaultModel: "sonnet",
			};
			edgeWorker = new EdgeWorker(configWithVersion);
			(edgeWorker as any).registerHealthEndpoint();

			const mockReply = {
				status: vi.fn().mockReturnThis(),
				send: vi.fn().mockReturnThis(),
			};

			expect(capturedHandler).not.toBeNull();
			await capturedHandler({}, mockReply);

			expect(mockReply.status).toHaveBeenCalledWith(200);

			const sentPayload = mockReply.send.mock.calls[0][0];
			expect(sentPayload.status).toBe("healthy");
			expect(typeof sentPayload.uptime).toBe("number");
			expect(sentPayload.uptime).toBeGreaterThanOrEqual(0);
			expect(sentPayload.activeSession).toBeNull();
			expect(sentPayload.queueLength).toEqual({});
			expect(sentPayload.lastCompletedAt).toBeNull();
			expect(sentPayload.version).toBe("2.0.0");
			expect(sentPayload.model).toBe("sonnet");
			expect(sentPayload.memoryUsage).toMatchObject({
				rss: expect.any(Number),
				heapUsed: expect.any(Number),
				heapTotal: expect.any(Number),
				external: expect.any(Number),
			});
		});

		it("should return null version and model when not configured", async () => {
			let capturedHandler: any = null;
			const mockGet = vi.fn((path: string, handler: any) => {
				if (path === "/health") {
					capturedHandler = handler;
				}
			});
			const mockFastify = { get: mockGet, post: vi.fn() };

			const { SharedApplicationServer } = await import(
				"../src/SharedApplicationServer.js"
			);
			vi.mocked(SharedApplicationServer).mockImplementation(
				() =>
					({
						initializeFastify: vi.fn(),
						getFastifyInstance: vi.fn().mockReturnValue(mockFastify),
						start: vi.fn().mockResolvedValue(undefined),
						stop: vi.fn().mockResolvedValue(undefined),
						getWebhookUrl: vi
							.fn()
							.mockReturnValue("http://localhost:3456/webhook"),
					}) as any,
			);

			edgeWorker = new EdgeWorker(mockConfig);
			(edgeWorker as any).registerHealthEndpoint();

			const mockReply = {
				status: vi.fn().mockReturnThis(),
				send: vi.fn().mockReturnThis(),
			};

			await capturedHandler({}, mockReply);

			const sentPayload = mockReply.send.mock.calls[0][0];
			expect(sentPayload.version).toBeNull();
			expect(sentPayload.model).toBeNull();
		});

		it("should include active session info when a session is running", async () => {
			const { AgentSessionStatus } = await import("cyrus-core");
			const now = Date.now();
			const mockSession = {
				id: "session-1",
				status: AgentSessionStatus.Active,
				createdAt: now - 30000, // 30 seconds ago
				updatedAt: now,
				issueContext: {
					trackerId: "linear",
					issueId: "issue-abc",
					issueIdentifier: "BRI-123",
				},
				repositories: [{ repositoryId: "test-repo" }],
				workspace: { worktreePath: "/test/worktrees/BRI-123" },
			};

			let capturedHandler: any = null;
			const mockGet = vi.fn((path: string, handler: any) => {
				if (path === "/health") {
					capturedHandler = handler;
				}
			});
			const mockFastify = { get: mockGet, post: vi.fn() };

			const { SharedApplicationServer } = await import(
				"../src/SharedApplicationServer.js"
			);
			vi.mocked(SharedApplicationServer).mockImplementation(
				() =>
					({
						initializeFastify: vi.fn(),
						getFastifyInstance: vi.fn().mockReturnValue(mockFastify),
						start: vi.fn().mockResolvedValue(undefined),
						stop: vi.fn().mockResolvedValue(undefined),
						getWebhookUrl: vi
							.fn()
							.mockReturnValue("http://localhost:3456/webhook"),
					}) as any,
			);

			const { AgentSessionManager } = await import(
				"../src/AgentSessionManager.js"
			);
			vi.mocked(AgentSessionManager).mockImplementation(
				() =>
					({
						getAllAgentRunners: vi.fn().mockReturnValue([]),
						getAllSessions: vi.fn().mockReturnValue([mockSession]),
						getActiveSessions: vi.fn().mockReturnValue([mockSession]),
						createCyrusAgentSession: vi.fn(),
						getSession: vi.fn(),
						getActiveSessionsByIssueId: vi.fn().mockReturnValue([]),
						setActivitySink: vi.fn(),
						on: vi.fn(),
						emit: vi.fn(),
					}) as any,
			);

			edgeWorker = new EdgeWorker(mockConfig);
			(edgeWorker as any).registerHealthEndpoint();

			const mockReply = {
				status: vi.fn().mockReturnThis(),
				send: vi.fn().mockReturnThis(),
			};

			await capturedHandler({}, mockReply);

			const sentPayload = mockReply.send.mock.calls[0][0];
			expect(sentPayload.status).toBe("healthy");
			expect(sentPayload.activeSession).not.toBeNull();
			expect(sentPayload.activeSession.issueId).toBe("BRI-123");
			expect(sentPayload.activeSession.repo).toBe("Test Repo");
			expect(sentPayload.activeSession.startedAt).toBe(
				new Date(now - 30000).toISOString(),
			);
			expect(sentPayload.activeSession.durationSeconds).toBeGreaterThanOrEqual(
				29,
			);
			expect(sentPayload.queueLength).toEqual({ "Test Repo": 1 });
		});

		it("should report lastCompletedAt from most recently completed session", async () => {
			const { AgentSessionStatus } = await import("cyrus-core");
			const completedAt = Date.now() - 5000;
			const mockCompletedSession = {
				id: "session-done",
				status: AgentSessionStatus.Complete,
				createdAt: completedAt - 60000,
				updatedAt: completedAt,
				issueContext: {
					trackerId: "linear",
					issueId: "issue-xyz",
					issueIdentifier: "BRI-100",
				},
				repositories: [{ repositoryId: "test-repo" }],
				workspace: { worktreePath: "/test/worktrees/BRI-100" },
			};

			let capturedHandler: any = null;
			const mockGet = vi.fn((path: string, handler: any) => {
				if (path === "/health") {
					capturedHandler = handler;
				}
			});
			const mockFastify = { get: mockGet, post: vi.fn() };

			const { SharedApplicationServer } = await import(
				"../src/SharedApplicationServer.js"
			);
			vi.mocked(SharedApplicationServer).mockImplementation(
				() =>
					({
						initializeFastify: vi.fn(),
						getFastifyInstance: vi.fn().mockReturnValue(mockFastify),
						start: vi.fn().mockResolvedValue(undefined),
						stop: vi.fn().mockResolvedValue(undefined),
						getWebhookUrl: vi
							.fn()
							.mockReturnValue("http://localhost:3456/webhook"),
					}) as any,
			);

			const { AgentSessionManager } = await import(
				"../src/AgentSessionManager.js"
			);
			vi.mocked(AgentSessionManager).mockImplementation(
				() =>
					({
						getAllAgentRunners: vi.fn().mockReturnValue([]),
						getAllSessions: vi.fn().mockReturnValue([mockCompletedSession]),
						getActiveSessions: vi.fn().mockReturnValue([]),
						createCyrusAgentSession: vi.fn(),
						getSession: vi.fn(),
						getActiveSessionsByIssueId: vi.fn().mockReturnValue([]),
						setActivitySink: vi.fn(),
						on: vi.fn(),
						emit: vi.fn(),
					}) as any,
			);

			edgeWorker = new EdgeWorker(mockConfig);
			(edgeWorker as any).registerHealthEndpoint();

			const mockReply = {
				status: vi.fn().mockReturnThis(),
				send: vi.fn().mockReturnThis(),
			};

			await capturedHandler({}, mockReply);

			const sentPayload = mockReply.send.mock.calls[0][0];
			expect(sentPayload.lastCompletedAt).toBe(
				new Date(completedAt).toISOString(),
			);
			expect(sentPayload.activeSession).toBeNull();
		});
	});
});
