import { LinearClient } from "@linear/sdk";
import { ClaudeRunner } from "cyrus-claude-runner";
import type { EdgeWorkerConfig, RepositoryConfig } from "cyrus-core";
import { LinearEventTransport } from "cyrus-linear-event-transport";
import { createCyrusToolsServer } from "cyrus-mcp-tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager.js";
import { EdgeWorker } from "../src/EdgeWorker.js";
import { SharedApplicationServer } from "../src/SharedApplicationServer.js";
import { TEST_CYRUS_HOME } from "./test-dirs.js";

// Mock all dependencies (mirrors EdgeWorker.issue-update-multiple-sessions.test.ts)
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
 * Tests for CYPACK-1273: honor the `prReviewTrigger` config flag in the
 * edge-worker GitHub webhook handler.
 *
 * When `prReviewTrigger === false`, a `pull_request_review` event that requests
 * changes must be ignored entirely — no acknowledgement comment and no agent
 * session. When the flag is `true` or unset (default), behaviour is unchanged.
 */
describe("EdgeWorker - PR review trigger gate (CYPACK-1273)", () => {
	let edgeWorker: EdgeWorker;
	let mockAgentSessionManager: any;
	let mockGitHubCommentService: any;

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

	// A `pull_request_review` event requesting changes (mirrors fixtures from
	// packages/github-event-transport/test/fixtures.ts).
	function createPrReviewEvent(): any {
		const repository = {
			full_name: "testorg/my-repo",
			name: "my-repo",
			owner: { login: "testorg" },
		};
		return {
			eventType: "pull_request_review",
			deliveryId: "delivery-pr-review-001",
			payload: {
				action: "submitted",
				review: {
					id: 777,
					body: "Please fix the error handling in the main function",
					state: "changes_requested",
					html_url:
						"https://github.com/testorg/my-repo/pull/42#pullrequestreview-777",
					user: { login: "reviewer" },
					submitted_at: "2025-01-15T10:30:00Z",
					commit_id: "abc123",
				},
				pull_request: {
					number: 42,
					title: "Fix failing tests",
					head: { ref: "fix-tests" },
					base: { ref: "main" },
				},
				repository,
				sender: { login: "reviewer" },
				installation: { id: 55555, node_id: "MDIzOk" },
			},
		};
	}

	function buildConfig(prReviewTrigger: boolean | undefined): EdgeWorkerConfig {
		return {
			proxyUrl: "http://localhost:3000",
			cyrusHome: TEST_CYRUS_HOME,
			repositories: [mockRepository],
			linearWorkspaces: {
				"test-workspace": { linearToken: "test-token" },
			},
			...(prReviewTrigger === undefined ? {} : { prReviewTrigger }),
			handlers: {
				createWorkspace: vi.fn().mockResolvedValue({
					path: "/test/workspaces/PR-42",
					isGitWorktree: false,
				}),
			},
		} as EdgeWorkerConfig;
	}

	function createWorker(prReviewTrigger: boolean | undefined): EdgeWorker {
		const worker = new EdgeWorker(buildConfig(prReviewTrigger));
		(worker as any).agentSessionManager = mockAgentSessionManager;
		(worker as any).gitHubCommentService = mockGitHubCommentService;
		// Token resolution succeeds so the (enabled) ack path can post.
		(worker as any).resolveGitHubToken = vi
			.fn()
			.mockResolvedValue("ghs_test_token");
		// Match the repo so the enabled path reaches the ack comment.
		(worker as any).findRepositoryByGitHubUrl = vi
			.fn()
			.mockReturnValue(mockRepository);
		// Stop the enabled path right after the ack comment (return early).
		(worker as any).createGitHubWorkspace = vi.fn().mockResolvedValue(null);
		return worker;
	}

	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		delete process.env.GITHUB_BOT_USERNAME;

		vi.mocked(createCyrusToolsServer).mockImplementation(() => {
			return { server: {} } as any;
		});

		vi.mocked(ClaudeRunner).mockImplementation(
			() =>
				({
					supportsStreamingInput: true,
					stop: vi.fn(),
					isStreaming: vi.fn().mockReturnValue(false),
					isRunning: vi.fn().mockReturnValue(false),
				}) as any,
		);

		mockAgentSessionManager = {
			getActiveMultiRepoSessionForRepository: vi.fn().mockReturnValue(null),
			getActiveSessionsByBranchName: vi.fn().mockReturnValue([]),
			createCyrusAgentSession: vi.fn(),
			getSession: vi.fn().mockReturnValue(null),
			setActivitySink: vi.fn(),
			addAgentRunner: vi.fn(),
			on: vi.fn(),
		};

		vi.mocked(AgentSessionManager).mockImplementation(
			() => mockAgentSessionManager,
		);

		mockGitHubCommentService = {
			postIssueComment: vi.fn().mockResolvedValue(undefined),
			addReaction: vi.fn().mockResolvedValue(undefined),
		};

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
						me: vi
							.fn()
							.mockResolvedValue({ id: "user-123", name: "Test User" }),
					},
				}) as any,
		);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("ignores a changes_requested review when prReviewTrigger is false", async () => {
		edgeWorker = createWorker(false);

		await (edgeWorker as any).handleGitHubWebhook(createPrReviewEvent());

		// No token resolution, no acknowledgement comment, no session.
		expect((edgeWorker as any).resolveGitHubToken).not.toHaveBeenCalled();
		expect(mockGitHubCommentService.postIssueComment).not.toHaveBeenCalled();
		expect(
			mockAgentSessionManager.createCyrusAgentSession,
		).not.toHaveBeenCalled();
	});

	it("posts an acknowledgement comment when prReviewTrigger is true", async () => {
		edgeWorker = createWorker(true);

		await (edgeWorker as any).handleGitHubWebhook(createPrReviewEvent());

		expect((edgeWorker as any).resolveGitHubToken).toHaveBeenCalled();
		expect(mockGitHubCommentService.postIssueComment).toHaveBeenCalledWith(
			expect.objectContaining({
				issueNumber: 42,
				body: "Received your change request. Getting started on those changes now.",
			}),
		);
	});

	it("posts an acknowledgement comment when prReviewTrigger is unset (default enabled)", async () => {
		edgeWorker = createWorker(undefined);

		await (edgeWorker as any).handleGitHubWebhook(createPrReviewEvent());

		expect((edgeWorker as any).resolveGitHubToken).toHaveBeenCalled();
		expect(mockGitHubCommentService.postIssueComment).toHaveBeenCalledWith(
			expect.objectContaining({
				issueNumber: 42,
				body: "Received your change request. Getting started on those changes now.",
			}),
		);
	});
});
