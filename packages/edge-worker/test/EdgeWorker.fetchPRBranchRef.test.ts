import { LinearClient } from "@linear/sdk";
import { ClaudeRunner } from "cyrus-claude-runner";
import type { GitHubWebhookEvent } from "cyrus-github-event-transport";
import { issueCommentPayload } from "cyrus-github-event-transport/test/fixtures";
import { LinearEventTransport } from "cyrus-linear-event-transport";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager.js";
import { EdgeWorker } from "../src/EdgeWorker.js";
import { SharedApplicationServer } from "../src/SharedApplicationServer.js";
import type { EdgeWorkerConfig, RepositoryConfig } from "../src/types.js";

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
		PersistenceManager: vi.fn().mockImplementation(() => ({
			loadEdgeWorkerState: vi.fn().mockResolvedValue(null),
			saveEdgeWorkerState: vi.fn().mockResolvedValue(undefined),
		})),
	};
});
vi.mock("file-type");

describe("EdgeWorker - fetchPRBranchRef", () => {
	let edgeWorker: EdgeWorker;
	let mockConfig: EdgeWorkerConfig;
	let mockLinearClient: any;
	let mockClaudeRunner: any;
	let mockAgentSessionManager: any;
	let mockRepository: RepositoryConfig;

	beforeEach(() => {
		vi.clearAllMocks();

		// Suppress console output
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});

		// Mock LinearClient
		mockLinearClient = {
			issue: vi.fn().mockResolvedValue({
				id: "test-issue-id",
				identifier: "TEST-1",
				title: "Test Issue",
				description: "Test description",
			}),
		};
		vi.mocked(LinearClient).mockImplementation(() => mockLinearClient);

		// Mock ClaudeRunner
		mockClaudeRunner = {
			run: vi.fn().mockResolvedValue({
				sessionId: "test-session-id",
				messageCount: 10,
			}),
			on: vi.fn(),
			removeAllListeners: vi.fn(),
		};
		vi.mocked(ClaudeRunner).mockImplementation(() => mockClaudeRunner);

		// Mock AgentSessionManager
		mockAgentSessionManager = {
			createSession: vi.fn().mockResolvedValue(undefined),
			recordThought: vi.fn().mockResolvedValue(undefined),
			recordAction: vi.fn().mockResolvedValue(undefined),
			completeSession: vi.fn().mockResolvedValue(undefined),
		};
		vi.mocked(AgentSessionManager).mockImplementation(
			() => mockAgentSessionManager,
		);

		// Mock LinearEventTransport
		const mockLinearEventTransport = {
			on: vi.fn(),
			start: vi.fn().mockResolvedValue(undefined),
			stop: vi.fn().mockResolvedValue(undefined),
		};
		vi.mocked(LinearEventTransport).mockImplementation(
			() => mockLinearEventTransport,
		);

		// Mock SharedApplicationServer
		const mockSharedAppServer = {
			start: vi.fn().mockResolvedValue(undefined),
			stop: vi.fn().mockResolvedValue(undefined),
		};
		vi.mocked(SharedApplicationServer).mockImplementation(
			() => mockSharedAppServer,
		);

		// Create EdgeWorker config
		mockConfig = {
			cyrusHome: "/tmp/test-cyrus-home",
			repositories: [],
		};

		// Create mock repository config
		mockRepository = {
			owner: "testorg",
			name: "my-repo",
			cloneUrl: "https://github.com/testorg/my-repo.git",
			basePath: "/tmp/test-repos",
			linearToken: "test-linear-token",
			primaryBranch: "main",
		};

		edgeWorker = new EdgeWorker(mockConfig);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("Authentication Token Handling", () => {
		it("should use event.installationToken when available instead of process.env.GITHUB_TOKEN", async () => {
			// Create event with installationToken
			const eventWithToken: GitHubWebhookEvent = {
				eventType: "issue_comment",
				deliveryId: "test-delivery-id",
				payload: issueCommentPayload,
				installationToken: "ghs_forwarded_installation_token_123",
			};

			// Mock GitHub API response
			const mockFetch = vi.fn().mockResolvedValue({
				ok: true,
				json: async () => ({
					head: {
						ref: "fix-tests",
					},
				}),
			});
			global.fetch = mockFetch;

			// Call fetchPRBranchRef via reflection (it's private)
			const result = await (edgeWorker as any).fetchPRBranchRef(
				eventWithToken,
				mockRepository,
			);

			// Verify the result
			expect(result).toBe("fix-tests");

			// THIS IS THE FAILING ASSERTION - the current implementation uses process.env.GITHUB_TOKEN
			// but it SHOULD use event.installationToken
			expect(mockFetch).toHaveBeenCalledWith(
				"https://api.github.com/repos/testorg/my-repo/pulls/42",
				{
					headers: {
						Accept: "application/vnd.github+json",
						"X-GitHub-Api-Version": "2022-11-28",
						Authorization: "Bearer ghs_forwarded_installation_token_123",
					},
				},
			);
		});

		it("should fall back to process.env.GITHUB_TOKEN when installationToken is not available", async () => {
			// Set process.env.GITHUB_TOKEN
			process.env.GITHUB_TOKEN = "ghp_env_token_456";

			// Create event without installationToken
			const eventWithoutToken: GitHubWebhookEvent = {
				eventType: "issue_comment",
				deliveryId: "test-delivery-id",
				payload: issueCommentPayload,
			};

			// Mock GitHub API response
			const mockFetch = vi.fn().mockResolvedValue({
				ok: true,
				json: async () => ({
					head: {
						ref: "fix-tests",
					},
				}),
			});
			global.fetch = mockFetch;

			// Call fetchPRBranchRef
			const result = await (edgeWorker as any).fetchPRBranchRef(
				eventWithoutToken,
				mockRepository,
			);

			// Verify the result
			expect(result).toBe("fix-tests");

			// Verify it used the environment variable
			expect(mockFetch).toHaveBeenCalledWith(
				"https://api.github.com/repos/testorg/my-repo/pulls/42",
				{
					headers: {
						Accept: "application/vnd.github+json",
						"X-GitHub-Api-Version": "2022-11-28",
						Authorization: "Bearer ghp_env_token_456",
					},
				},
			);

			// Cleanup
			delete process.env.GITHUB_TOKEN;
		});

		it("should make unauthenticated request when neither token is available", async () => {
			// Ensure no GITHUB_TOKEN in env
			delete process.env.GITHUB_TOKEN;

			// Create event without installationToken
			const eventWithoutToken: GitHubWebhookEvent = {
				eventType: "issue_comment",
				deliveryId: "test-delivery-id",
				payload: issueCommentPayload,
			};

			// Mock GitHub API response (this will fail with 404 for private repos)
			const mockFetch = vi.fn().mockResolvedValue({
				ok: false,
				status: 404,
			});
			global.fetch = mockFetch;

			// Call fetchPRBranchRef
			const result = await (edgeWorker as any).fetchPRBranchRef(
				eventWithoutToken,
				mockRepository,
			);

			// Verify it returns null due to 404
			expect(result).toBe(null);

			// Verify it attempted an unauthenticated request (no Authorization header)
			expect(mockFetch).toHaveBeenCalledWith(
				"https://api.github.com/repos/testorg/my-repo/pulls/42",
				{
					headers: {
						Accept: "application/vnd.github+json",
						"X-GitHub-Api-Version": "2022-11-28",
						// No Authorization header
					},
				},
			);
		});
	});
});
