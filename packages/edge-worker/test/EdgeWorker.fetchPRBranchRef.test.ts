import { LinearClient } from "@linear/sdk";
import { ClaudeRunner } from "atmiko-claude-runner";
import type { GitHubWebhookEvent } from "atmiko-github-event-transport";
import { issueCommentPayload } from "atmiko-github-event-transport/test/fixtures";
import { LinearEventTransport } from "atmiko-linear-event-transport";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager.js";
import { EdgeWorker } from "../src/EdgeWorker.js";
import { SharedApplicationServer } from "../src/SharedApplicationServer.js";
import type { EdgeWorkerConfig, RepositoryConfig } from "../src/types.js";
import { TEST_ATMIKO_HOME } from "./test-dirs.js";

// Mock dependencies
vi.mock("atmiko-claude-runner");
vi.mock("atmiko-linear-event-transport");
vi.mock("@linear/sdk");
vi.mock("../src/SharedApplicationServer.js");
vi.mock("../src/AgentSessionManager.js");
vi.mock("atmiko-core", async (importOriginal) => {
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
vi.mock("file-type");

describe("EdgeWorker - fetchPRBranchRefs", () => {
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
		vi.mocked(LinearClient).mockImplementation(function () {
			return mockLinearClient;
		});

		// Mock ClaudeRunner
		mockClaudeRunner = {
			run: vi.fn().mockResolvedValue({
				sessionId: "test-session-id",
				messageCount: 10,
			}),
			on: vi.fn(),
			removeAllListeners: vi.fn(),
		};
		vi.mocked(ClaudeRunner).mockImplementation(function () {
			return mockClaudeRunner;
		});

		// Mock AgentSessionManager
		mockAgentSessionManager = {
			createSession: vi.fn().mockResolvedValue(undefined),
			recordThought: vi.fn().mockResolvedValue(undefined),
			recordAction: vi.fn().mockResolvedValue(undefined),
			completeSession: vi.fn().mockResolvedValue(undefined),
			setActivitySink: vi.fn(),
			on: vi.fn(),
		};
		vi.mocked(AgentSessionManager).mockImplementation(function () {
			return mockAgentSessionManager;
		});

		// Mock LinearEventTransport
		const mockLinearEventTransport = {
			on: vi.fn(),
			start: vi.fn().mockResolvedValue(undefined),
			stop: vi.fn().mockResolvedValue(undefined),
		};
		vi.mocked(LinearEventTransport).mockImplementation(function () {
			return mockLinearEventTransport;
		});

		// Mock SharedApplicationServer
		const mockSharedAppServer = {
			start: vi.fn().mockResolvedValue(undefined),
			stop: vi.fn().mockResolvedValue(undefined),
		};
		vi.mocked(SharedApplicationServer).mockImplementation(function () {
			return mockSharedAppServer;
		});

		// Create EdgeWorker config
		mockConfig = {
			atmikoHome: TEST_ATMIKO_HOME,
			repositories: [],
		};

		// Create mock repository config
		mockRepository = {
			owner: "testorg",
			name: "my-repo",
			cloneUrl: "https://github.com/testorg/my-repo.git",
			basePath: "/tmp/test-repos",
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
					base: {
						ref: "main",
					},
				}),
			});
			global.fetch = mockFetch;

			// Call fetchPRBranchRefs via reflection (it's private)
			const result = await (edgeWorker as any).fetchPRBranchRefs(
				eventWithToken,
				mockRepository,
			);

			// Verify the result
			expect(result).toEqual({ headRef: "fix-tests", baseRef: "main" });

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
					base: {
						ref: "develop",
					},
				}),
			});
			global.fetch = mockFetch;

			// Call fetchPRBranchRefs
			const result = await (edgeWorker as any).fetchPRBranchRefs(
				eventWithoutToken,
				mockRepository,
			);

			// Verify the result
			expect(result).toEqual({ headRef: "fix-tests", baseRef: "develop" });

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

			// Call fetchPRBranchRefs
			const result = await (edgeWorker as any).fetchPRBranchRefs(
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
