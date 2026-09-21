import { EventEmitter } from "node:events";
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
		PersistenceManager: vi.fn().mockImplementation(function () {
			return {
				loadEdgeWorkerState: vi.fn().mockResolvedValue(null),
				saveEdgeWorkerState: vi.fn().mockResolvedValue(undefined),
			};
		}),
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

	function createPrCommentEvent(
		eventType: "issue_comment" | "pull_request_review_comment",
		author: string,
	): any {
		const { repository, pull_request } = createPrReviewEvent().payload;
		return {
			eventType,
			deliveryId: "delivery-pr-comment-001",
			payload: {
				action: "created",
				comment: {
					id: 888,
					html_url:
						"https://github.com/testorg/my-repo/pull/42#issuecomment-888",
					body: "Review handled; comment posted as @at-miko[bot].",
					user: { login: author },
				},
				...(eventType === "issue_comment"
					? { issue: { ...pull_request, pull_request: {} } }
					: { pull_request }),
				repository,
				sender: { login: author },
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
		vi.stubEnv("GITHUB_BOT_USERNAME", undefined);

		vi.mocked(createCyrusToolsServer).mockImplementation(() => {
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
			createCyrusAgentSession: vi.fn(),
			getSession: vi.fn().mockReturnValue(null),
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
		};

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
					me: vi.fn().mockResolvedValue({ id: "user-123", name: "Test User" }),
				},
			};
		} as any);
	});

	function configureReplyRunner(mode: "success" | "result-error" | "throw") {
		edgeWorker = createWorker(true);
		const result = { type: "result", is_error: mode !== "success" };
		const runner = {
			getMessages: () => [
				{
					type: "assistant",
					message: { content: [{ type: "text", text: "Request handled." }] },
				},
				result,
			],
			start: vi.fn(async () => {
				if (mode === "throw") throw new Error("runner crashed");
				return { sessionId: "feedback-session" };
			}),
		};
		(edgeWorker as any).createGitHubWorkspace = vi.fn().mockResolvedValue({
			path: "/test/workspaces/PR-42",
			isGitWorktree: true,
		});
		(edgeWorker as any).fetchPRBranchRefs = vi
			.fn()
			.mockResolvedValue({ headRef: "fix-tests", baseRef: "main" });
		mockAgentSessionManager.getSession.mockReturnValue({ metadata: {} });
		(edgeWorker as any).buildAgentRunnerConfig = vi
			.fn()
			.mockResolvedValue({ config: {}, runnerType: "claude" });
		(edgeWorker as any).createRunnerForType = vi.fn().mockReturnValue(runner);
		(edgeWorker as any).savePersistedState = vi
			.fn()
			.mockResolvedValue(undefined);
		return runner;
	}

	it.each([
		"success",
		"result-error",
		"throw",
	] as const)("finishes the triggering comment's reaction for %s", async (mode) => {
		configureReplyRunner(mode);
		const event = createPrCommentEvent("issue_comment", "requester");
		await (edgeWorker as any).handleGitHubWebhook(event);
		expect(mockGitHubCommentService.postIssueComment).toHaveBeenCalledWith(
			expect.objectContaining({
				replyToUrl: event.payload.comment.html_url,
			}),
		);
		expect(
			mockGitHubCommentService.addReaction.mock.calls.map(
				([p]: any[]) => p.content,
			),
		).toEqual(["eyes", mode === "success" ? "+1" : "confused"]);
		expect(mockGitHubCommentService.deleteReaction).toHaveBeenCalledWith(
			expect.objectContaining({ commentId: 888, reactionId: 901 }),
		);
	});

	it("replies to the root of an inline thread while reacting to the comment that mentioned Cyrus", async () => {
		configureReplyRunner("success");
		const event = createPrCommentEvent(
			"pull_request_review_comment",
			"requester",
		);
		event.payload.comment.in_reply_to_id = 444;
		await (edgeWorker as any).handleGitHubWebhook(event);
		expect(
			mockGitHubCommentService.postReviewCommentReply,
		).toHaveBeenCalledWith(
			expect.objectContaining({ commentId: 444, body: "Request handled." }),
		);
		expect(mockGitHubCommentService.postIssueComment).not.toHaveBeenCalled();
		expect(mockGitHubCommentService.deleteReaction).toHaveBeenCalledWith(
			expect.objectContaining({ commentId: 888, reactionId: 901 }),
		);
	});

	it("keeps queued requests in their inline thread with an eyes reaction until execution", async () => {
		const runner = configureReplyRunner("success");
		const event = createPrCommentEvent(
			"pull_request_review_comment",
			"requester",
		);
		event.payload.comment.in_reply_to_id = 444;
		(edgeWorker as any).activeGitHubPrSessions.add("github:testorg/my-repo#42");
		await (edgeWorker as any).handleGitHubWebhook(event);
		expect(runner.start).not.toHaveBeenCalled();
		expect(
			mockGitHubCommentService.postReviewCommentReply,
		).toHaveBeenCalledWith(
			expect.objectContaining({
				commentId: 444,
				body: expect.stringContaining("queued"),
			}),
		);
		expect(mockGitHubCommentService.postIssueComment).not.toHaveBeenCalled();
		expect(
			mockGitHubCommentService.addReaction.mock.calls.map(
				([p]: any[]) => p.content,
			),
		).toEqual(["eyes"]);
		expect(mockGitHubCommentService.deleteReaction).not.toHaveBeenCalled();
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	it.each([
		"issue_comment",
		"pull_request_review_comment",
	] as const)("does not enqueue its own %s containing a self-mention", async (eventType) => {
		vi.stubEnv("GITHUB_BOT_USERNAME", "at-miko");
		edgeWorker = createWorker(true);
		const sessionKey = "github:testorg/my-repo#42";
		(edgeWorker as any).activeGitHubPrSessions.add(sessionKey);

		await (edgeWorker as any).handleGitHubWebhook(
			createPrCommentEvent(eventType, "at-miko[bot]"),
		);

		expect((edgeWorker as any).resolveGitHubToken).not.toHaveBeenCalled();
		expect(mockGitHubCommentService.addReaction).not.toHaveBeenCalled();
		expect(mockGitHubCommentService.postIssueComment).not.toHaveBeenCalled();
		expect((edgeWorker as any).queuedGitHubPrEvents.size).toBe(0);
		expect((edgeWorker as any).activeGitHubPrSessions.has(sessionKey)).toBe(
			true,
		);
		expect(
			mockAgentSessionManager.createCyrusAgentSession,
		).not.toHaveBeenCalled();
	});

	it.each([
		["at-miko", "at-miko[bot]"],
		["at-miko[bot]", "at-miko[bot]"],
		["At-Miko", "at-miko[bot]"],
		["at-miko", "at-miko"],
	])("ignores its own change request with configured login %s and author %s", async (configuredLogin, author) => {
		vi.stubEnv("GITHUB_BOT_USERNAME", configuredLogin);
		edgeWorker = createWorker(true);
		const event = createPrReviewEvent();
		event.payload.review.user.login = author;
		event.payload.sender.login = author;

		await (edgeWorker as any).handleGitHubWebhook(event);

		expect((edgeWorker as any).resolveGitHubToken).not.toHaveBeenCalled();
		expect(mockGitHubCommentService.postIssueComment).not.toHaveBeenCalled();
		expect(
			mockAgentSessionManager.createCyrusAgentSession,
		).not.toHaveBeenCalled();
	});

	it.each([
		"github-actions[bot]",
		"reviewer",
		"at-miko-helper[bot]",
	])("still accepts a mention from %s", async (author) => {
		vi.stubEnv("GITHUB_BOT_USERNAME", "at-miko");
		edgeWorker = createWorker(true);
		(edgeWorker as any).fetchPRBranchRefs = vi.fn().mockResolvedValue({
			headRef: "fix-tests",
			baseRef: "main",
		});

		await (edgeWorker as any).handleGitHubWebhook(
			createPrCommentEvent("issue_comment", author),
		);

		expect(
			mockGitHubCommentService.addReaction.mock.calls.map(
				([p]: any[]) => p.content,
			),
		).toEqual(["eyes", "confused"]);
		expect((edgeWorker as any).createGitHubWorkspace).toHaveBeenCalledWith(
			mockRepository,
			"fix-tests",
			42,
		);
	});

	it("uses an error result immediately even before the runner stores it", async () => {
		const runner = configureReplyRunner("success");
		let onMessage: (message: any) => Promise<void>;
		(edgeWorker as any).createRunnerForType.mockImplementation(
			(_type: string, config: any) => {
				onMessage = config.onMessage;
				return runner;
			},
		);
		runner.start.mockImplementation(async () => {
			await onMessage({ type: "result", is_error: true });
			return { sessionId: "feedback-session" };
		});
		await (edgeWorker as any).handleGitHubWebhook(
			createPrCommentEvent("issue_comment", "requester"),
		);
		expect(
			mockGitHubCommentService.addReaction.mock.calls.map(
				([p]: any[]) => p.content,
			),
		).toEqual(["eyes", "confused"]);
		expect(mockGitHubCommentService.postIssueComment).toHaveBeenCalledWith(
			expect.objectContaining({
				body: "The task did not complete successfully. Please check the Cyrus session logs before retrying.",
			}),
		);
	});

	it("does not leave a late eyes reaction after a fast completion", async () => {
		const runner = configureReplyRunner("success");
		let acknowledge!: (id: number) => void;
		mockGitHubCommentService.addReaction.mockImplementationOnce(
			() =>
				new Promise<number>((resolve) => {
					acknowledge = resolve;
				}),
		);
		const handling = (edgeWorker as any).handleGitHubWebhook(
			createPrCommentEvent("issue_comment", "requester"),
		);
		await vi.waitFor(() => expect(acknowledge).toBeTypeOf("function"));
		expect(runner.start).not.toHaveBeenCalled();
		acknowledge(902);
		await handling;
		expect(mockGitHubCommentService.deleteReaction).toHaveBeenCalledWith(
			expect.objectContaining({ reactionId: 902 }),
		);
	});

	it("marks a delivery failure without claiming successful completion", async () => {
		configureReplyRunner("success");
		mockGitHubCommentService.postIssueComment.mockRejectedValueOnce(
			new Error("GitHub unavailable"),
		);
		await (edgeWorker as any).handleGitHubWebhook(
			createPrCommentEvent("issue_comment", "requester"),
		);
		expect(
			mockGitHubCommentService.addReaction.mock.calls.map(
				([p]: any[]) => p.content,
			),
		).toEqual(["eyes", "confused"]);
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

	it("queues a second PR trigger until the running session completes", async () => {
		edgeWorker = createWorker(true);
		const firstEvent = createPrReviewEvent();
		const secondEvent = {
			...createPrReviewEvent(),
			deliveryId: "delivery-pr-review-002",
		};

		let finishFirstRunner: (sessionInfo: { sessionId: string }) => void;
		const firstRunner = {
			start: vi.fn(
				() =>
					new Promise<{ sessionId: string }>((resolve) => {
						finishFirstRunner = resolve;
					}),
			),
		};
		const secondRunner = {
			start: vi.fn().mockResolvedValue({ sessionId: "second-session" }),
		};

		(edgeWorker as any).createGitHubWorkspace = vi.fn().mockResolvedValue({
			path: "/test/workspaces/PR-42",
			isGitWorktree: true,
		});
		mockAgentSessionManager.getSession.mockReturnValue({ metadata: {} });
		(edgeWorker as any).buildAgentRunnerConfig = vi.fn().mockResolvedValue({
			config: {},
			runnerType: "claude",
		});
		(edgeWorker as any).createRunnerForType = vi
			.fn()
			.mockReturnValueOnce(firstRunner)
			.mockReturnValueOnce(secondRunner);
		(edgeWorker as any).postGitHubReply = vi.fn().mockResolvedValue(undefined);
		(edgeWorker as any).savePersistedState = vi
			.fn()
			.mockResolvedValue(undefined);

		const firstHandling = (edgeWorker as any).handleGitHubWebhook(firstEvent);
		await vi.waitFor(() => expect(firstRunner.start).toHaveBeenCalledOnce());

		await (edgeWorker as any).handleGitHubWebhook(secondEvent);
		expect(
			mockAgentSessionManager.createCyrusAgentSession,
		).toHaveBeenCalledTimes(1);
		expect(secondRunner.start).not.toHaveBeenCalled();

		finishFirstRunner!({ sessionId: "first-session" });
		await firstHandling;
		await vi.waitFor(() => expect(secondRunner.start).toHaveBeenCalledOnce());

		expect(
			mockAgentSessionManager.createCyrusAgentSession,
		).toHaveBeenCalledTimes(2);
	});

	it("starts the next queued trigger when a warm runner emits a result", async () => {
		edgeWorker = createWorker(true);
		const firstEvent = createPrReviewEvent();
		const secondEvent = {
			...createPrReviewEvent(),
			deliveryId: "delivery-pr-review-002",
		};
		const firstRunner = Object.assign(new EventEmitter(), {
			supportsStreamingInput: true,
			completeStream: vi.fn(),
			start: vi.fn(() => new Promise(() => {})),
		});
		const secondRunner = {
			start: vi.fn().mockResolvedValue({ sessionId: "second-session" }),
		};

		(edgeWorker as any).createGitHubWorkspace = vi.fn().mockResolvedValue({
			path: "/test/workspaces/PR-42",
			isGitWorktree: true,
		});
		mockAgentSessionManager.getSession.mockReturnValue({ metadata: {} });
		(edgeWorker as any).buildAgentRunnerConfig = vi.fn().mockResolvedValue({
			config: {},
			runnerType: "claude",
		});
		(edgeWorker as any).createRunnerForType = vi
			.fn()
			.mockImplementationOnce((_runnerType: string, config: any) => {
				firstRunner.on("message", config.onMessage);
				return firstRunner;
			})
			.mockReturnValueOnce(secondRunner);
		(edgeWorker as any).postGitHubReply = vi.fn().mockResolvedValue(undefined);
		(edgeWorker as any).savePersistedState = vi
			.fn()
			.mockResolvedValue(undefined);

		void (edgeWorker as any).handleGitHubWebhook(firstEvent);
		await vi.waitFor(() => expect(firstRunner.start).toHaveBeenCalledOnce());
		await (edgeWorker as any).handleGitHubWebhook(secondEvent);

		firstRunner.emit("message", { type: "result" });

		await vi.waitFor(() => expect(secondRunner.start).toHaveBeenCalledOnce());
		expect(firstRunner.completeStream).toHaveBeenCalledOnce();
	});
});
