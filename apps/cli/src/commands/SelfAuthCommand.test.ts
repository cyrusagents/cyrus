import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Use vi.hoisted to create mock functions that can be used in vi.mock
const mocks = vi.hoisted(() => ({
	mockReadFileSync: vi.fn(),
	mockWriteFileSync: vi.fn(),
	mockOpen: vi.fn(),
	mockFetch: vi.fn(),
	mockFastifyInstance: {
		get: vi.fn(),
		listen: vi.fn(),
		close: vi.fn(),
	},
	mockFastify: vi.fn(),
}));

// Mock modules
vi.mock("node:fs", () => ({
	readFileSync: mocks.mockReadFileSync,
	writeFileSync: mocks.mockWriteFileSync,
}));

// Mock Fastify
vi.mock("fastify", () => ({
	default: mocks.mockFastify,
}));

vi.mock("open", () => ({
	default: mocks.mockOpen,
}));

// Mock LinearClient
const mockLinearClient = {
	viewer: Promise.resolve({
		organization: Promise.resolve({
			id: "workspace-123",
			name: "Test Workspace",
		}),
	}),
};

vi.mock("@linear/sdk", async (importOriginal) => {
	const actual = await importOriginal();
	return {
		...(actual as object),
		LinearClient: vi.fn(() => mockLinearClient),
	};
});

// Mock process.exit
const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
	throw new Error("process.exit called");
});

// Mock console methods
const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
const _mockConsoleError = vi
	.spyOn(console, "error")
	.mockImplementation(() => {});

// Import after mocks
import { SelfAuthCommand } from "./SelfAuthCommand.js";

type RouteHandler = (...args: unknown[]) => unknown;

// Mock Application
const createMockApp = () => ({
	cyrusHome: "/home/user/.cyrus",
	config: {
		exists: vi.fn().mockReturnValue(true),
		load: vi.fn(),
		update: vi.fn(),
	},
	getProxyUrl: vi.fn().mockReturnValue("https://proxy.example.com"),
	logger: {
		info: vi.fn(),
		error: vi.fn(),
		warn: vi.fn(),
		success: vi.fn(),
		divider: vi.fn(),
	},
});

describe("SelfAuthCommand", () => {
	let mockApp: ReturnType<typeof createMockApp>;
	let command: SelfAuthCommand;
	let originalEnv: NodeJS.ProcessEnv;

	beforeEach(() => {
		vi.clearAllMocks();
		mockApp = createMockApp();
		command = new SelfAuthCommand(mockApp as any);
		originalEnv = { ...process.env };

		// Reset Fastify mock instance
		mocks.mockFastifyInstance.get.mockReset();
		mocks.mockFastifyInstance.listen.mockReset();
		mocks.mockFastifyInstance.close.mockReset();

		// Setup default Fastify mock
		mocks.mockFastify.mockReturnValue(mocks.mockFastifyInstance);
		mocks.mockFastifyInstance.listen.mockResolvedValue(undefined);
		mocks.mockFastifyInstance.close.mockResolvedValue(undefined);
		mocks.mockOpen.mockResolvedValue(undefined);

		// Setup global fetch mock
		global.fetch = mocks.mockFetch;
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	describe("Environment Variable Validation", () => {
		it("should error when LINEAR_CLIENT_ID is missing", async () => {
			delete process.env.LINEAR_CLIENT_ID;
			process.env.LINEAR_CLIENT_SECRET = "test-secret";
			process.env.CYRUS_BASE_URL = "https://example.com";

			await expect(command.execute([])).rejects.toThrow("process.exit called");
			expect(mockExit).toHaveBeenCalledWith(1);
			expect(mockConsoleLog).toHaveBeenCalledWith(
				expect.stringContaining("LINEAR_CLIENT_ID"),
			);
		});

		it("should error when LINEAR_CLIENT_SECRET is missing", async () => {
			process.env.LINEAR_CLIENT_ID = "test-client-id";
			delete process.env.LINEAR_CLIENT_SECRET;
			process.env.CYRUS_BASE_URL = "https://example.com";

			await expect(command.execute([])).rejects.toThrow("process.exit called");
			expect(mockExit).toHaveBeenCalledWith(1);
			expect(mockConsoleLog).toHaveBeenCalledWith(
				expect.stringContaining("LINEAR_CLIENT_SECRET"),
			);
		});

		it("should error when CYRUS_BASE_URL is missing", async () => {
			process.env.LINEAR_CLIENT_ID = "test-client-id";
			process.env.LINEAR_CLIENT_SECRET = "test-secret";
			delete process.env.CYRUS_BASE_URL;

			await expect(command.execute([])).rejects.toThrow("process.exit called");
			expect(mockExit).toHaveBeenCalledWith(1);
			expect(mockConsoleLog).toHaveBeenCalledWith(
				expect.stringContaining("CYRUS_BASE_URL"),
			);
		});
	});

	describe("Config File Validation", () => {
		it("should error when config file does not exist", async () => {
			process.env.LINEAR_CLIENT_ID = "test-client-id";
			process.env.LINEAR_CLIENT_SECRET = "test-secret";
			process.env.CYRUS_BASE_URL = "https://example.com";

			mocks.mockReadFileSync.mockImplementation(() => {
				throw new Error("ENOENT: no such file or directory");
			});

			await expect(command.execute([])).rejects.toThrow("process.exit called");
			expect(mockExit).toHaveBeenCalledWith(1);
		});

		it("should error when config file is invalid JSON", async () => {
			process.env.LINEAR_CLIENT_ID = "test-client-id";
			process.env.LINEAR_CLIENT_SECRET = "test-secret";
			process.env.CYRUS_BASE_URL = "https://example.com";

			mocks.mockReadFileSync.mockReturnValue("invalid json{");

			await expect(command.execute([])).rejects.toThrow("process.exit called");
			expect(mockExit).toHaveBeenCalledWith(1);
		});
	});

	describe("OAuth Flow", () => {
		beforeEach(() => {
			process.env.LINEAR_CLIENT_ID = "test-client-id";
			process.env.LINEAR_CLIENT_SECRET = "test-secret";
			process.env.CYRUS_BASE_URL = "https://example.com";

			mocks.mockReadFileSync.mockReturnValue(
				JSON.stringify({
					repositories: [
						{
							id: "repo-1",
							name: "test-repo",
							linearWorkspaceId: "",
							linearToken: "",
						},
					],
				}),
			);
		});

		it("should start Fastify server on correct port", async () => {
			// Simulate server starting but never resolving to test startup
			mocks.mockFastifyInstance.listen.mockImplementation(
				async (options: { port: number; host: string }) => {
					expect(options.port).toBe(3456);
					expect(options.host).toBe("localhost");
					// Never resolve to avoid waiting for auth
					return new Promise(() => {});
				},
			);

			// This will hang waiting for listen to resolve
			const _executePromise = command.execute([]);

			// Give it a moment to start
			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(mocks.mockFastify).toHaveBeenCalledWith({ logger: false });
			expect(mocks.mockFastifyInstance.get).toHaveBeenCalledWith(
				"/callback",
				expect.any(Function),
			);
		});

		it("should open browser with correct OAuth URL", async () => {
			let routeHandler: RouteHandler;

			// Capture the route handler when get() is called
			mocks.mockFastifyInstance.get.mockImplementation(
				(_path: string, handler: RouteHandler) => {
					routeHandler = handler;
				},
			);

			// When listen is called, simulate the callback arriving
			mocks.mockFastifyInstance.listen.mockImplementation(async () => {
				// Simulate OAuth callback with code after a short delay
				setTimeout(async () => {
					const mockRequest = {
						query: { code: "test-auth-code" },
					};
					const mockReply = {
						type: vi.fn().mockReturnThis(),
						code: vi.fn().mockReturnThis(),
						send: vi.fn().mockReturnThis(),
					};
					await routeHandler(mockRequest, mockReply);
				}, 10);
			});

			// Mock token exchange
			mocks.mockFetch.mockResolvedValueOnce({
				ok: true,
				json: () =>
					Promise.resolve({
						access_token: "lin_oauth_test_token",
						refresh_token: "refresh_test_token",
					}),
			});

			await expect(command.execute([])).rejects.toThrow("process.exit called");
			expect(mockExit).toHaveBeenCalledWith(0); // Success exit

			expect(mocks.mockOpen).toHaveBeenCalledWith(
				expect.stringContaining("https://linear.app/oauth/authorize"),
			);
			expect(mocks.mockOpen).toHaveBeenCalledWith(
				expect.stringContaining("client_id=test-client-id"),
			);
		});

		it("should handle OAuth error response", async () => {
			let routeHandler: RouteHandler;

			// Capture the route handler when get() is called
			mocks.mockFastifyInstance.get.mockImplementation(
				(_path: string, handler: RouteHandler) => {
					routeHandler = handler;
				},
			);

			// When listen is called, simulate the error callback arriving
			mocks.mockFastifyInstance.listen.mockImplementation(async () => {
				setTimeout(async () => {
					const mockRequest = {
						query: { error: "access_denied" },
					};
					const mockReply = {
						type: vi.fn().mockReturnThis(),
						code: vi.fn().mockReturnThis(),
						send: vi.fn().mockReturnThis(),
					};
					await routeHandler(mockRequest, mockReply);
				}, 10);
			});

			await expect(command.execute([])).rejects.toThrow("process.exit called");
			expect(mockExit).toHaveBeenCalledWith(1);
		});
	});

	describe("Token Exchange", () => {
		beforeEach(() => {
			process.env.LINEAR_CLIENT_ID = "test-client-id";
			process.env.LINEAR_CLIENT_SECRET = "test-secret";
			process.env.CYRUS_BASE_URL = "https://example.com";

			mocks.mockReadFileSync.mockReturnValue(
				JSON.stringify({
					repositories: [{ id: "repo-1", linearWorkspaceId: "" }],
				}),
			);
		});

		it("should exchange code for tokens with correct parameters", async () => {
			let routeHandler: RouteHandler;

			// Capture the route handler when get() is called
			mocks.mockFastifyInstance.get.mockImplementation(
				(_path: string, handler: RouteHandler) => {
					routeHandler = handler;
				},
			);

			// When listen is called, simulate the callback arriving
			mocks.mockFastifyInstance.listen.mockImplementation(async () => {
				setTimeout(async () => {
					const mockRequest = { query: { code: "auth-code-123" } };
					const mockReply = {
						type: vi.fn().mockReturnThis(),
						code: vi.fn().mockReturnThis(),
						send: vi.fn().mockReturnThis(),
					};
					await routeHandler(mockRequest, mockReply);
				}, 10);
			});

			mocks.mockFetch.mockResolvedValueOnce({
				ok: true,
				json: () =>
					Promise.resolve({
						access_token: "lin_oauth_new_token",
						refresh_token: "refresh_token",
					}),
			});

			await expect(command.execute([])).rejects.toThrow("process.exit called");

			// Verify token exchange call
			expect(mocks.mockFetch).toHaveBeenCalledWith(
				"https://api.linear.app/oauth/token",
				expect.objectContaining({
					method: "POST",
					headers: { "Content-Type": "application/x-www-form-urlencoded" },
				}),
			);

			const tokenCall = mocks.mockFetch.mock.calls[0];
			const body = tokenCall[1].body;
			expect(body).toContain("code=auth-code-123");
			expect(body).toContain("client_id=test-client-id");
			expect(body).toContain("client_secret=test-secret");
			expect(body).toContain("grant_type=authorization_code");
		});

		it("should error on invalid access token format", async () => {
			let routeHandler: RouteHandler;

			// Capture the route handler when get() is called
			mocks.mockFastifyInstance.get.mockImplementation(
				(_path: string, handler: RouteHandler) => {
					routeHandler = handler;
				},
			);

			// When listen is called, simulate the callback arriving
			mocks.mockFastifyInstance.listen.mockImplementation(async () => {
				setTimeout(async () => {
					const mockRequest = { query: { code: "auth-code" } };
					const mockReply = {
						type: vi.fn().mockReturnThis(),
						code: vi.fn().mockReturnThis(),
						send: vi.fn().mockReturnThis(),
					};
					await routeHandler(mockRequest, mockReply);
				}, 10);
			});

			mocks.mockFetch.mockResolvedValueOnce({
				ok: true,
				json: () =>
					Promise.resolve({
						access_token: "invalid_token_format", // Missing lin_oauth_ prefix
						refresh_token: "refresh",
					}),
			});

			await expect(command.execute([])).rejects.toThrow("process.exit called");
			expect(mockExit).toHaveBeenCalledWith(1);
		});
	});

	describe("Config Update", () => {
		beforeEach(() => {
			process.env.LINEAR_CLIENT_ID = "test-client-id";
			process.env.LINEAR_CLIENT_SECRET = "test-secret";
			process.env.CYRUS_BASE_URL = "https://example.com";
		});

		it("should update repositories matching workspace ID", async () => {
			mocks.mockReadFileSync.mockReturnValue(
				JSON.stringify({
					repositories: [
						{ id: "repo-1", linearWorkspaceId: "ws-123", linearToken: "old" },
						{ id: "repo-2", linearWorkspaceId: "ws-456", linearToken: "other" },
						{ id: "repo-3", linearWorkspaceId: "ws-123", linearToken: "old" },
					],
				}),
			);

			let routeHandler: RouteHandler;
			mocks.mockFastifyInstance.get.mockImplementation(
				(_path: string, handler: RouteHandler) => {
					routeHandler = handler;
				},
			);
			mocks.mockFastifyInstance.listen.mockImplementation(async () => {
				setTimeout(async () => {
					const mockRequest = { query: { code: "code" } };
					const mockReply = {
						type: vi.fn().mockReturnThis(),
						code: vi.fn().mockReturnThis(),
						send: vi.fn().mockReturnThis(),
					};
					await routeHandler(mockRequest, mockReply);
				}, 10);
			});

			mocks.mockFetch.mockResolvedValueOnce({
				ok: true,
				json: () =>
					Promise.resolve({
						access_token: "lin_oauth_new",
						refresh_token: "refresh_new",
					}),
			});

			// Update the LinearClient mock for this specific test
			const { LinearClient } = await import("@linear/sdk");
			(LinearClient as any).mockImplementation(() => ({
				viewer: Promise.resolve({
					organization: Promise.resolve({
						id: "ws-123",
						name: "Workspace",
					}),
				}),
			}));

			await expect(command.execute([])).rejects.toThrow("process.exit called");
			expect(mockExit).toHaveBeenCalledWith(0);

			// Verify config was written
			expect(mocks.mockWriteFileSync).toHaveBeenCalled();
			const writtenConfig = JSON.parse(
				mocks.mockWriteFileSync.mock.calls[0][1],
			);

			// repos with ws-123 should be updated
			expect(writtenConfig.repositories[0].linearToken).toBe("lin_oauth_new");
			expect(writtenConfig.repositories[0].linearRefreshToken).toBe(
				"refresh_new",
			);
			expect(writtenConfig.repositories[2].linearToken).toBe("lin_oauth_new");

			// repo with ws-456 should NOT be updated
			expect(writtenConfig.repositories[1].linearToken).toBe("other");
		});

		it("should update repositories with empty workspace ID", async () => {
			mocks.mockReadFileSync.mockReturnValue(
				JSON.stringify({
					repositories: [
						{ id: "repo-1", linearWorkspaceId: "", linearToken: "" },
						{ id: "repo-2", linearWorkspaceId: "ws-456", linearToken: "keep" },
					],
				}),
			);

			let routeHandler: RouteHandler;
			mocks.mockFastifyInstance.get.mockImplementation(
				(_path: string, handler: RouteHandler) => {
					routeHandler = handler;
				},
			);
			mocks.mockFastifyInstance.listen.mockImplementation(async () => {
				setTimeout(async () => {
					const mockRequest = { query: { code: "code" } };
					const mockReply = {
						type: vi.fn().mockReturnThis(),
						code: vi.fn().mockReturnThis(),
						send: vi.fn().mockReturnThis(),
					};
					await routeHandler(mockRequest, mockReply);
				}, 10);
			});

			mocks.mockFetch.mockResolvedValueOnce({
				ok: true,
				json: () =>
					Promise.resolve({
						access_token: "lin_oauth_new",
						refresh_token: "refresh",
					}),
			});

			// Update the LinearClient mock for this specific test
			const { LinearClient } = await import("@linear/sdk");
			(LinearClient as any).mockImplementation(() => ({
				viewer: Promise.resolve({
					organization: Promise.resolve({
						id: "ws-new",
						name: "New Workspace",
					}),
				}),
			}));

			await expect(command.execute([])).rejects.toThrow("process.exit called");

			const writtenConfig = JSON.parse(
				mocks.mockWriteFileSync.mock.calls[0][1],
			);

			// repo with empty workspace should be updated with new workspace
			expect(writtenConfig.repositories[0].linearToken).toBe("lin_oauth_new");
			expect(writtenConfig.repositories[0].linearWorkspaceId).toBe("ws-new");
			expect(writtenConfig.repositories[0].linearWorkspaceName).toBe(
				"New Workspace",
			);

			// repo with different workspace should NOT be updated
			expect(writtenConfig.repositories[1].linearToken).toBe("keep");
		});
	});
});
