import { LinearClient } from "@linear/sdk";
import type { EdgeWorkerConfig } from "cyrus-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EdgeWorker } from "../src/EdgeWorker.js";

// Mock modules
vi.mock("@linear/sdk");
vi.mock("../src/SharedApplicationServer.js", () => ({
	SharedApplicationServer: vi.fn().mockImplementation(() => ({
		start: vi.fn(),
		registerLinearEventTransport: vi.fn(),
		registerConfigUpdater: vi.fn(),
		registerOAuthCallback: vi.fn(),
	})),
}));

// Mock fs/promises for file operations
vi.mock("node:fs/promises", () => ({
	readFile: vi.fn().mockResolvedValue(
		JSON.stringify({
			repositories: [
				{
					id: "repo-1",
					linearWorkspaceId: "workspace-123",
				},
				{
					id: "repo-2",
					linearWorkspaceId: "workspace-123",
				},
			],
			linearWorkspaces: {
				"workspace-123": {
					linearToken: "old_token",
					linearRefreshToken: "old_refresh_token",
				},
			},
		}),
	),
	writeFile: vi.fn().mockResolvedValue(undefined),
	mkdir: vi.fn().mockResolvedValue(undefined),
	readdir: vi.fn().mockResolvedValue([]),
	rename: vi.fn().mockResolvedValue(undefined),
}));

// Mock global fetch
global.fetch = vi.fn();

describe("EdgeWorker LinearClient Wrapper", () => {
	let edgeWorker: EdgeWorker;
	let mockConfig: EdgeWorkerConfig;
	let mockLinearClient: any;

	beforeEach(() => {
		vi.clearAllMocks();

		// Setup mock config
		mockConfig = {
			repositories: [
				{
					id: "repo-1",
					name: "test-repo-1",
					repositoryPath: "/test/repo1",
					workspaceBaseDir: "/test/workspaces",
					baseBranch: "main",
					linearWorkspaceId: "workspace-123",
				},
			],
			linearWorkspaces: {
				"workspace-123": {
					linearToken: "test_token",
					linearRefreshToken: "refresh_token",
					linearWorkspaceName: "Test Workspace",
				},
			},
			cyrusHome: "/test/.cyrus",
			serverPort: 3456,
			serverHost: "localhost",
		};

		// Mock environment variables
		process.env.LINEAR_CLIENT_ID = "test_client_id";
		process.env.LINEAR_CLIENT_SECRET = "test_client_secret";

		// Create mock LinearClient with methods and underlying GraphQL client
		mockLinearClient = {
			issue: vi.fn(),
			viewer: Promise.resolve({
				organization: Promise.resolve({
					id: "workspace-123",
					name: "Test Workspace",
				}),
			}),
			createAgentActivity: vi.fn(),
			// Mock the underlying GraphQL client for token refresh patching
			client: {
				request: vi.fn(),
				setHeader: vi.fn(),
			},
		};

		// Mock LinearClient constructor
		vi.mocked(LinearClient).mockImplementation(() => mockLinearClient);
	});

	describe("Auto-retry on 401 errors", () => {
		it("should pass through successful API calls", async () => {
			mockLinearClient.issue.mockResolvedValueOnce({
				id: "issue-123",
				title: "Test Issue",
			});

			edgeWorker = new EdgeWorker(mockConfig);
			const issueTrackers = (edgeWorker as any).issueTrackers;
			const issueTracker = issueTrackers.get("workspace-123");

			const result = await issueTracker?.fetchIssue("issue-123");

			expect(result).toBeDefined();
			expect(mockLinearClient.issue).toHaveBeenCalledTimes(1);
		});

		it("should pass through non-401 errors without retry", async () => {
			const error = new Error("Network error");
			(error as any).status = 500;
			mockLinearClient.issue.mockRejectedValueOnce(error);

			edgeWorker = new EdgeWorker(mockConfig);
			const issueTrackers = (edgeWorker as any).issueTrackers;
			const issueTracker = issueTrackers.get("workspace-123");

			await expect(issueTracker?.fetchIssue("issue-123")).rejects.toThrow(
				"Network error",
			);

			// Should only be called once (no retry for non-401)
			expect(mockLinearClient.issue).toHaveBeenCalledTimes(1);
		});

		it("should not configure token refresh without refresh token", async () => {
			// Setup config without refresh token
			mockConfig.linearWorkspaces!["workspace-123"].linearRefreshToken =
				undefined;
			edgeWorker = new EdgeWorker(mockConfig);

			// The issueTracker should be created but without OAuth config
			const issueTrackers = (edgeWorker as any).issueTrackers;
			const issueTracker = issueTrackers.get("workspace-123");
			expect(issueTracker).toBeDefined();
			// OAuth config should not be set (no refresh capability)
			expect((issueTracker as any).oauthConfig).toBeUndefined();
		});

		it("should not configure token refresh without OAuth credentials", async () => {
			// Remove OAuth credentials
			delete process.env.LINEAR_CLIENT_ID;
			delete process.env.LINEAR_CLIENT_SECRET;

			edgeWorker = new EdgeWorker(mockConfig);

			// The issueTracker should be created but without OAuth config
			const issueTrackers = (edgeWorker as any).issueTrackers;
			const issueTracker = issueTrackers.get("workspace-123");
			expect(issueTracker).toBeDefined();
			// OAuth config should not be set (no refresh capability)
			expect((issueTracker as any).oauthConfig).toBeUndefined();
		});
	});

	describe("OAuth config setup", () => {
		it("should configure OAuth with correct credentials", async () => {
			edgeWorker = new EdgeWorker(mockConfig);

			const issueTrackers = (edgeWorker as any).issueTrackers;
			const issueTracker = issueTrackers.get("workspace-123");
			const oauthConfig = (issueTracker as any).oauthConfig;

			expect(oauthConfig).toBeDefined();
			expect(oauthConfig.clientId).toBe("test_client_id");
			expect(oauthConfig.clientSecret).toBe("test_client_secret");
			expect(oauthConfig.refreshToken).toBe("refresh_token");
			expect(oauthConfig.workspaceId).toBe("workspace-123");
			expect(oauthConfig.onTokenRefresh).toBeDefined();
		});
	});

	describe("Dynamic Linear token updates", () => {
		it("should call setAccessToken on existing issue trackers when workspace token changes", () => {
			edgeWorker = new EdgeWorker(mockConfig);

			const issueTrackers = (edgeWorker as any).issueTrackers;
			const issueTracker = issueTrackers.get("workspace-123");
			const setAccessTokenSpy = vi.spyOn(issueTracker, "setAccessToken");

			const newConfig: EdgeWorkerConfig = {
				...mockConfig,
				linearWorkspaces: {
					"workspace-123": {
						linearToken: "refreshed_token",
						linearRefreshToken: "new_refresh_token",
						linearWorkspaceName: "Test Workspace",
					},
				},
			};

			(edgeWorker as any).updateLinearWorkspaceTokens(newConfig);

			expect(setAccessTokenSpy).toHaveBeenCalledWith("refreshed_token");
		});

		it("should not call setAccessToken when token has not changed", () => {
			edgeWorker = new EdgeWorker(mockConfig);

			const issueTrackers = (edgeWorker as any).issueTrackers;
			const issueTracker = issueTrackers.get("workspace-123");
			const setAccessTokenSpy = vi.spyOn(issueTracker, "setAccessToken");

			// Same token as the original config
			const newConfig: EdgeWorkerConfig = {
				...mockConfig,
				linearWorkspaces: {
					"workspace-123": {
						linearToken: "test_token",
						linearRefreshToken: "refresh_token",
						linearWorkspaceName: "Test Workspace",
					},
				},
			};

			(edgeWorker as any).updateLinearWorkspaceTokens(newConfig);

			expect(setAccessTokenSpy).not.toHaveBeenCalled();
		});

		it("should update AttachmentService when workspace token changes", () => {
			edgeWorker = new EdgeWorker(mockConfig);

			const attachmentService = (edgeWorker as any).attachmentService;
			const setLinearWorkspacesSpy = vi.spyOn(
				attachmentService,
				"setLinearWorkspaces",
			);

			const newWorkspaces = {
				"workspace-123": {
					linearToken: "refreshed_token",
					linearRefreshToken: "new_refresh_token",
					linearWorkspaceName: "Test Workspace",
				},
			};

			const newConfig: EdgeWorkerConfig = {
				...mockConfig,
				linearWorkspaces: newWorkspaces,
			};

			(edgeWorker as any).updateLinearWorkspaceTokens(newConfig);

			expect(setLinearWorkspacesSpy).toHaveBeenCalledWith(newWorkspaces);
		});

		it("should create a new issue tracker for a previously unknown workspace", () => {
			edgeWorker = new EdgeWorker(mockConfig);

			const issueTrackers = (edgeWorker as any).issueTrackers;
			expect(issueTrackers.has("workspace-456")).toBe(false);

			const newConfig: EdgeWorkerConfig = {
				...mockConfig,
				linearWorkspaces: {
					...mockConfig.linearWorkspaces,
					"workspace-456": {
						linearToken: "new_workspace_token",
						linearRefreshToken: "new_refresh",
						linearWorkspaceName: "New Workspace",
					},
				},
			};

			(edgeWorker as any).updateLinearWorkspaceTokens(newConfig);

			expect(issueTrackers.has("workspace-456")).toBe(true);
		});
	});
});
