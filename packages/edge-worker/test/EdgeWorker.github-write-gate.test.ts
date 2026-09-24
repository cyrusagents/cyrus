import { EventEmitter } from "node:events";
import { LinearClient } from "@linear/sdk";
import { ClaudeRunner } from "miko-claude-runner";
import type { EdgeWorkerConfig, RepositoryConfig } from "miko-core";
import { LinearEventTransport } from "miko-linear-event-transport";
import { createMikoToolsServer } from "miko-mcp-tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager.js";
import { EdgeWorker } from "../src/EdgeWorker.js";
import { SharedApplicationServer } from "../src/SharedApplicationServer.js";
import { TEST_MIKO_HOME } from "./test-dirs.js";

vi.mock("fs/promises");
vi.mock("miko-claude-runner");
vi.mock("miko-mcp-tools");
vi.mock("miko-codex-runner");
vi.mock("miko-linear-event-transport");
vi.mock("@linear/sdk");
vi.mock("../src/SharedApplicationServer.js");
vi.mock("../src/AgentSessionManager.js");
vi.mock("miko-core", async (importOriginal) => {
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
 * Hard collaborator write gate for GitHub @mention / review wakes:
 * only users with write|maintain|admin may start a session.
 */
describe("EdgeWorker - GitHub collaborator write gate", () => {
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

	function createMentionEvent(author: string): any {
		const repository = {
			full_name: "testorg/my-repo",
			name: "my-repo",
			owner: { login: "testorg" },
		};
		return {
			eventType: "issue_comment",
			deliveryId: `delivery-mention-${author}`,
			payload: {
				action: "created",
				comment: {
					id: 888,
					html_url:
						"https://github.com/testorg/my-repo/pull/42#issuecomment-888",
					body: "@mikoagent please fix the flaky test",
					user: { login: author },
				},
				issue: {
					number: 42,
					title: "Fix failing tests",
					pull_request: {},
				},
				repository,
				sender: { login: author },
				installation: { id: 55555, node_id: "MDIzOk" },
			},
		};
	}

	function createPrReviewEvent(author: string): any {
		const repository = {
			full_name: "testorg/my-repo",
			name: "my-repo",
			owner: { login: "testorg" },
		};
		return {
			eventType: "pull_request_review",
			deliveryId: `delivery-review-${author}`,
			payload: {
				action: "submitted",
				review: {
					id: 777,
					body: "Please fix the error handling",
					state: "changes_requested",
					html_url:
						"https://github.com/testorg/my-repo/pull/42#pullrequestreview-777",
					user: { login: author },
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
				sender: { login: author },
				installation: { id: 55555, node_id: "MDIzOk" },
			},
		};
	}

	function buildConfig(): EdgeWorkerConfig {
		return {
			proxyUrl: "http://localhost:3000",
			mikoHome: TEST_MIKO_HOME,
			repositories: [mockRepository],
			linearWorkspaces: {
				"test-workspace": { linearToken: "test-token" },
			},
			handlers: {
				createWorkspace: vi.fn().mockResolvedValue({
					path: "/test/workspaces/PR-42",
					isGitWorktree: false,
				}),
			},
		} as EdgeWorkerConfig;
	}

	function createWorker(): EdgeWorker {
		const worker = new EdgeWorker(buildConfig());
		(worker as any).agentSessionManager = mockAgentSessionManager;
		(worker as any).gitHubCommentService = mockGitHubCommentService;
		(worker as any).resolveGitHubToken = vi
			.fn()
			.mockResolvedValue("ghs_test_token");
		(worker as any).findRepositoryByGitHubUrl = vi
			.fn()
			.mockReturnValue(mockRepository);
		(worker as any).createGitHubWorkspace = vi.fn().mockResolvedValue({
			path: "/test/workspaces/PR-42",
			isGitWorktree: false,
		});
		(worker as any).fetchPRBranchRefs = vi.fn().mockResolvedValue({
			headRef: "fix-tests",
			baseRef: "main",
		});
		(worker as any).buildAgentRunnerConfig = vi.fn().mockResolvedValue({
			config: { onMessage: undefined },
			runnerType: "claude",
		});
		(worker as any).createRunnerForType = vi.fn().mockReturnValue({
			start: vi.fn().mockResolvedValue({ sessionId: "sess-1" }),
			completeStream: vi.fn(),
		});
		(worker as any).postGitHubReply = vi.fn().mockResolvedValue(true);
		(worker as any).savePersistedState = vi.fn().mockResolvedValue(undefined);
		(worker as any).getActivitySinkForRepo = vi.fn().mockReturnValue(null);
		(worker as any).toolPermissionResolver = {
			buildGithubAllowedTools: vi.fn().mockReturnValue(["Read", "Edit"]),
		};
		(worker as any).buildDisallowedTools = vi.fn().mockReturnValue([]);
		(worker as any).buildSkillSessionContext = vi.fn().mockReturnValue({});
		(worker as any).buildGitHubSystemPrompt = vi.fn().mockReturnValue("prompt");
		(worker as any).buildGitHubChangeRequestSystemPrompt = vi
			.fn()
			.mockReturnValue("prompt");
		return worker;
	}

	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.stubEnv("GITHUB_BOT_USERNAME", "mikoagent");

		vi.mocked(createMikoToolsServer).mockImplementation(() => {
			return { server: {} } as any;
		});

		vi.mocked(ClaudeRunner).mockImplementation(function () {
			return {
				supportsStreamingInput: true,
				stop: vi.fn(),
				isStreaming: vi.fn().mockReturnValue(false),
				isRunning: vi.fn().mockReturnValue(false),
			};
		} as any);

		mockAgentSessionManager = {
			getActiveMultiRepoSessionForRepository: vi.fn().mockReturnValue(null),
			getActiveSessionsByBranchName: vi.fn().mockReturnValue([]),
			createMikoAgentSession: vi.fn(),
			getSession: vi.fn().mockReturnValue({
				id: "github-sess",
				metadata: {},
			}),
			setActivitySink: vi.fn(),
			addAgentRunner: vi.fn(),
			on: vi.fn(),
		};

		vi.mocked(AgentSessionManager).mockImplementation(function () {
			return mockAgentSessionManager;
		});

		mockGitHubCommentService = {
			postIssueComment: vi.fn().mockResolvedValue(undefined),
			postReviewCommentReply: vi.fn().mockResolvedValue(undefined),
			addReaction: vi.fn().mockResolvedValue(901),
			deleteReaction: vi.fn().mockResolvedValue(undefined),
			isReviewFullyResolved: vi.fn().mockResolvedValue(false),
			hasRepoWriteAccess: vi.fn().mockResolvedValue({
				allowed: true,
				permission: "write",
			}),
		};

		vi.mocked(SharedApplicationServer).mockImplementation(function () {
			return {
				on: vi.fn(),
				start: vi.fn(),
				stop: vi.fn(),
			} as any;
		});

		vi.mocked(LinearEventTransport).mockImplementation(function () {
			return new EventEmitter() as any;
		});

		vi.mocked(LinearClient).mockImplementation(function () {
			return {} as any;
		});

		edgeWorker = createWorker();
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	it("allows write collaborators to start a session from an @mention", async () => {
		mockGitHubCommentService.hasRepoWriteAccess.mockResolvedValue({
			allowed: true,
			permission: "write",
		});

		await (edgeWorker as any).handleGitHubWebhook(createMentionEvent("writer"));

		expect(mockGitHubCommentService.hasRepoWriteAccess).toHaveBeenCalledWith({
			token: "ghs_test_token",
			owner: "testorg",
			repo: "my-repo",
			username: "writer",
		});
		expect(
			mockAgentSessionManager.createMikoAgentSession,
		).toHaveBeenCalledOnce();
		expect(mockGitHubCommentService.postIssueComment).not.toHaveBeenCalled();
	});

	it("allows admin collaborators to start a session", async () => {
		mockGitHubCommentService.hasRepoWriteAccess.mockResolvedValue({
			allowed: true,
			permission: "admin",
		});

		await (edgeWorker as any).handleGitHubWebhook(createMentionEvent("admin"));

		expect(
			mockAgentSessionManager.createMikoAgentSession,
		).toHaveBeenCalledOnce();
	});

	it("denies read-only users, posts a brief reply, and does not open a session", async () => {
		mockGitHubCommentService.hasRepoWriteAccess.mockResolvedValue({
			allowed: false,
			permission: "read",
			reason: "insufficient_permission",
		});

		await (edgeWorker as any).handleGitHubWebhook(createMentionEvent("reader"));

		expect(
			mockAgentSessionManager.createMikoAgentSession,
		).not.toHaveBeenCalled();
		expect((edgeWorker as any).createGitHubWorkspace).not.toHaveBeenCalled();
		expect(mockGitHubCommentService.postIssueComment).toHaveBeenCalledWith(
			expect.objectContaining({
				issueNumber: 42,
				body: expect.stringContaining("Write (collaborator) access"),
			}),
		);
	});

	it("denies 404 / non-collaborators without opening a session", async () => {
		mockGitHubCommentService.hasRepoWriteAccess.mockResolvedValue({
			allowed: false,
			permission: null,
			reason: "not_a_collaborator",
		});

		await (edgeWorker as any).handleGitHubWebhook(
			createMentionEvent("outsider"),
		);

		expect(
			mockAgentSessionManager.createMikoAgentSession,
		).not.toHaveBeenCalled();
		expect(mockGitHubCommentService.postIssueComment).toHaveBeenCalledOnce();
	});

	it("denies change-request reviews from non-writers without opening a session", async () => {
		mockGitHubCommentService.hasRepoWriteAccess.mockResolvedValue({
			allowed: false,
			permission: "read",
			reason: "insufficient_permission",
		});

		await (edgeWorker as any).handleGitHubWebhook(
			createPrReviewEvent("reader"),
		);

		expect(
			mockAgentSessionManager.createMikoAgentSession,
		).not.toHaveBeenCalled();
		expect(mockGitHubCommentService.postIssueComment).toHaveBeenCalledWith(
			expect.objectContaining({
				body: expect.stringContaining("Write (collaborator) access"),
			}),
		);
	});

	it("fails closed when no GitHub token is available", async () => {
		(edgeWorker as any).resolveGitHubToken = vi
			.fn()
			.mockResolvedValue(undefined);

		await (edgeWorker as any).handleGitHubWebhook(createMentionEvent("writer"));

		expect(mockGitHubCommentService.hasRepoWriteAccess).not.toHaveBeenCalled();
		expect(
			mockAgentSessionManager.createMikoAgentSession,
		).not.toHaveBeenCalled();
	});
});
