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
		createLinearAgentSession: vi.fn(),
		getSession: vi.fn(),
		getActiveSessionsByIssueId: vi.fn().mockReturnValue([]),
		on: vi.fn(), // EventEmitter method
		emit: vi.fn(), // EventEmitter method
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

describe("EdgeWorker - Status Endpoint", () => {
	let edgeWorker: EdgeWorker;
	let mockConfig: EdgeWorkerConfig;
	let _registeredGetHandler:
		| ((request: any, reply: any) => Promise<any>)
		| null = null;

	const mockRepository: RepositoryConfig = {
		id: "test-repo",
		name: "Test Repo",
		repositoryPath: "/test/repo",
		workspaceBaseDir: "/test/workspaces",
		baseBranch: "main",
		linearToken: "test-token",
		linearWorkspaceId: "test-workspace",
		isActive: true,
	};

	beforeEach(() => {
		vi.clearAllMocks();
		_registeredGetHandler = null;

		// Mock console methods
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});

		mockConfig = {
			platform: "linear",
			cyrusHome: "/test/.cyrus",
			repositories: [mockRepository],
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

	describe("computeStatus", () => {
		it("should return idle when no webhooks are being processed and no runners are active", async () => {
			edgeWorker = new EdgeWorker(mockConfig);

			// Access the private method via type assertion for testing
			const status = (edgeWorker as any).computeStatus();

			expect(status).toBe("idle");
		});

		it("should return busy when activeWebhookCount > 0", async () => {
			edgeWorker = new EdgeWorker(mockConfig);

			// Simulate webhook processing
			(edgeWorker as any).activeWebhookCount = 1;

			const status = (edgeWorker as any).computeStatus();

			expect(status).toBe("busy");
		});

		it("should return busy when a runner is running", async () => {
			edgeWorker = new EdgeWorker(mockConfig);

			// Create a mock runner that is running
			const mockRunner = {
				isRunning: vi.fn().mockReturnValue(true),
			};

			// Create a mock session manager that returns the mock runner
			const mockSessionManager = {
				getAllAgentRunners: vi.fn().mockReturnValue([mockRunner]),
			};

			// Set the mock session manager
			(edgeWorker as any).agentSessionManagers.set(
				"test-repo",
				mockSessionManager,
			);

			const status = (edgeWorker as any).computeStatus();

			expect(status).toBe("busy");
			expect(mockRunner.isRunning).toHaveBeenCalled();
		});

		it("should return idle when runner exists but is not running", async () => {
			edgeWorker = new EdgeWorker(mockConfig);

			// Create a mock runner that is not running
			const mockRunner = {
				isRunning: vi.fn().mockReturnValue(false),
			};

			// Create a mock session manager that returns the mock runner
			const mockSessionManager = {
				getAllAgentRunners: vi.fn().mockReturnValue([mockRunner]),
			};

			// Set the mock session manager
			(edgeWorker as any).agentSessionManagers.set(
				"test-repo",
				mockSessionManager,
			);

			const status = (edgeWorker as any).computeStatus();

			expect(status).toBe("idle");
		});

		it("should return busy when multiple runners exist and at least one is running", async () => {
			edgeWorker = new EdgeWorker(mockConfig);

			// Create mock runners - one running, one not
			const mockRunner1 = {
				isRunning: vi.fn().mockReturnValue(false),
			};
			const mockRunner2 = {
				isRunning: vi.fn().mockReturnValue(true),
			};

			// Create a mock session manager that returns both runners
			const mockSessionManager = {
				getAllAgentRunners: vi.fn().mockReturnValue([mockRunner1, mockRunner2]),
			};

			// Set the mock session manager
			(edgeWorker as any).agentSessionManagers.set(
				"test-repo",
				mockSessionManager,
			);

			const status = (edgeWorker as any).computeStatus();

			expect(status).toBe("busy");
		});

		it("should check all session managers across multiple repositories", async () => {
			edgeWorker = new EdgeWorker(mockConfig);

			// Create mock runners for different repos - repo1 idle, repo2 busy
			const mockRunner1 = {
				isRunning: vi.fn().mockReturnValue(false),
			};
			const mockRunner2 = {
				isRunning: vi.fn().mockReturnValue(true),
			};

			const mockSessionManager1 = {
				getAllAgentRunners: vi.fn().mockReturnValue([mockRunner1]),
			};
			const mockSessionManager2 = {
				getAllAgentRunners: vi.fn().mockReturnValue([mockRunner2]),
			};

			// Set multiple session managers
			(edgeWorker as any).agentSessionManagers.set(
				"repo-1",
				mockSessionManager1,
			);
			(edgeWorker as any).agentSessionManagers.set(
				"repo-2",
				mockSessionManager2,
			);

			const status = (edgeWorker as any).computeStatus();

			expect(status).toBe("busy");
			expect(mockSessionManager1.getAllAgentRunners).toHaveBeenCalled();
			expect(mockSessionManager2.getAllAgentRunners).toHaveBeenCalled();
		});
	});

	describe("activeWebhookCount tracking", () => {
		it("should increment and decrement activeWebhookCount during webhook handling", async () => {
			edgeWorker = new EdgeWorker(mockConfig);

			// Verify initial state
			expect((edgeWorker as any).activeWebhookCount).toBe(0);

			// Call handleWebhook with a mock webhook that doesn't match any handler
			const mockWebhook = { action: "unknown" };
			await (edgeWorker as any).handleWebhook(mockWebhook, [mockRepository]);

			// After completion, count should be back to 0
			expect((edgeWorker as any).activeWebhookCount).toBe(0);
		});

		it("should decrement activeWebhookCount even when handler throws an error", async () => {
			edgeWorker = new EdgeWorker(mockConfig);

			// Mock isIssueUnassignedWebhook to return true and make the handler throw
			const { isIssueUnassignedWebhook } = await import("cyrus-core");
			vi.mocked(isIssueUnassignedWebhook).mockReturnValue(true);

			// Mock the handler to throw
			(edgeWorker as any).handleIssueUnassignedWebhook = vi
				.fn()
				.mockRejectedValue(new Error("Test error"));

			// Call handleWebhook
			const mockWebhook = { action: "issueUnassigned", notification: {} };
			await (edgeWorker as any).handleWebhook(mockWebhook, [mockRepository]);

			// Count should still be 0 after error (finally block executed)
			expect((edgeWorker as any).activeWebhookCount).toBe(0);
		});
	});

	describe("registerStatusEndpoint", () => {
		it("should register GET /status endpoint with Fastify", async () => {
			const mockGet = vi.fn();
			const mockFastify = {
				get: mockGet,
				post: vi.fn(),
			};

			// Create EdgeWorker with mock that captures the registered handler
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

			// Call registerStatusEndpoint
			(edgeWorker as any).registerStatusEndpoint();

			// Verify GET /status was registered
			expect(mockGet).toHaveBeenCalledWith("/status", expect.any(Function));
		});

		it("should return idle status via the endpoint handler", async () => {
			let capturedHandler: any = null;
			const mockGet = vi.fn((path: string, handler: any) => {
				if (path === "/status") {
					capturedHandler = handler;
				}
			});
			const mockFastify = {
				get: mockGet,
				post: vi.fn(),
			};

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
			(edgeWorker as any).registerStatusEndpoint();

			// Mock reply object
			const mockReply = {
				status: vi.fn().mockReturnThis(),
				send: vi.fn().mockReturnThis(),
			};

			// Call the captured handler
			expect(capturedHandler).not.toBeNull();
			await capturedHandler({}, mockReply);

			expect(mockReply.status).toHaveBeenCalledWith(200);
			expect(mockReply.send).toHaveBeenCalledWith({ status: "idle" });
		});

		it("should return busy status via the endpoint handler when webhook is processing", async () => {
			let capturedHandler: any = null;
			const mockGet = vi.fn((path: string, handler: any) => {
				if (path === "/status") {
					capturedHandler = handler;
				}
			});
			const mockFastify = {
				get: mockGet,
				post: vi.fn(),
			};

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
			(edgeWorker as any).registerStatusEndpoint();

			// Simulate active webhook
			(edgeWorker as any).activeWebhookCount = 1;

			// Mock reply object
			const mockReply = {
				status: vi.fn().mockReturnThis(),
				send: vi.fn().mockReturnThis(),
			};

			// Call the captured handler
			expect(capturedHandler).not.toBeNull();
			await capturedHandler({}, mockReply);

			expect(mockReply.status).toHaveBeenCalledWith(200);
			expect(mockReply.send).toHaveBeenCalledWith({ status: "busy" });
		});
	});
});
