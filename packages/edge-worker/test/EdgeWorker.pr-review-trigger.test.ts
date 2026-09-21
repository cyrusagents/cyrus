import { EventEmitter } from "node:events";
import { LinearClient } from "@linear/sdk";
import { ClaudeRunner } from "cyrus-claude-runner";
import type { EdgeWorkerConfig, RepositoryConfig } from "cyrus-core";
import { LinearEventTransport } from "cyrus-linear-event-transport";
import { createCyrusToolsServer } from "cyrus-mcp-tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager.js";
import { EdgeWorker } from "../src/EdgeWorker.js";
import { getAutomaticReviewId } from "../src/GitHubFeedback.js";
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
		// Token resolution succeeds so enabled requests can update reactions.
		(worker as any).resolveGitHubToken = vi
			.fn()
			.mockResolvedValue("ghs_test_token");
		// Match the repo so enabled requests reach workspace creation.
		(worker as any).findRepositoryByGitHubUrl = vi
			.fn()
			.mockReturnValue(mockRepository);
		// Stop before creating a runner unless a test explicitly configures one.
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
			isReviewFullyResolved: vi.fn().mockResolvedValue(false),
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

	it("acknowledges queued inline requests with eyes without posting a queue comment", async () => {
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
		).not.toHaveBeenCalled();
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

	it("accepts a change request silently when prReviewTrigger is true", async () => {
		edgeWorker = createWorker(true);

		await (edgeWorker as any).handleGitHubWebhook(createPrReviewEvent());

		expect((edgeWorker as any).resolveGitHubToken).toHaveBeenCalled();
		expect(mockGitHubCommentService.postIssueComment).not.toHaveBeenCalled();
		expect((edgeWorker as any).createGitHubWorkspace).toHaveBeenCalled();
	});

	it("accepts a change request silently when prReviewTrigger is unset", async () => {
		edgeWorker = createWorker(undefined);

		await (edgeWorker as any).handleGitHubWebhook(createPrReviewEvent());

		expect((edgeWorker as any).resolveGitHubToken).toHaveBeenCalled();
		expect(mockGitHubCommentService.postIssueComment).not.toHaveBeenCalled();
		expect((edgeWorker as any).createGitHubWorkspace).toHaveBeenCalled();
	});

	function codexRequest() {
		const event = createPrCommentEvent("issue_comment", "github-actions[bot]");
		event.payload.comment.body =
			"<!-- miko-codex:42:5265084414 -->\n@at-miko[bot] Address this Codex review.\n\nReview: https://github.com/testorg/my-repo/pull/42#pullrequestreview-5265084414\nState: COMMENTED";
		return event;
	}

	it("recognizes the exact automated review notification", () => {
		expect(getAutomaticReviewId(codexRequest())).toBe(5265084414);
	});

	it.each([
		"https://github.com/testorg/another-repo/pull/42#pullrequestreview-5265084414",
		"https://github.com/testorg/my-repo/pull/43#pullrequestreview-5265084414",
		"https://example.com/testorg/my-repo/pull/42#pullrequestreview-5265084414",
		"https://github.com/testorg/my-repo/pull/42?extra=true#pullrequestreview-5265084414",
		"https://someone@github.com/testorg/my-repo/pull/42#pullrequestreview-5265084414",
		"https://github.com/testorg/my-repo/pull/42#issuecomment-5265084414",
		"https://github.com/testorg/my-repo/pull/42#pullrequestreview-9007199254740993",
	])("keeps an unrecognized review reference as a normal request (%s)", (url) => {
		const event = codexRequest();
		event.payload.comment.body = `@at-miko[bot] Please inspect this.\nReview: ${url}`;
		expect(getAutomaticReviewId(event)).toBeUndefined();
	});

	const expectedReplyDelivery = `## Reply delivery
- Handle only the triggering request above. Other PR comments and reviews are context, not additional assignments; Cyrus schedules those requests separately.
- Cyrus publishes your final answer as the reply to this request. Do not post receipt, progress, or completion comments yourself with gh pr comment, the GitHub API, or MCP tools.
- If the request explicitly requires a formal PR review or an inline review-thread reply, create that requested artifact, but do not add a separate status comment.
- Return one concise final answer describing the concrete outcome and validation. If a stop hook asks you to check shipping, verify it and keep the final answer about the original task, not local tracking housekeeping.`;

	it("gives comment sessions one reply owner and limits work to the triggering request", () => {
		edgeWorker = createWorker(true);
		expect(
			(edgeWorker as any).buildGitHubSystemPrompt(
				createPrCommentEvent("issue_comment", "maintainer"),
				"fix-tests",
				"Review the error handling.",
			),
		).toBe(`You are working on a GitHub Pull Request.

## Context
- **Repository**: testorg/my-repo
- **PR**: #42 - Fix failing tests
- **Branch**: fix-tests
- **Requested by**: @maintainer
- **Comment URL**: https://github.com/testorg/my-repo/pull/42#issuecomment-888

## Task
Review the error handling.

## Instructions
- You are already checked out on the PR branch \`fix-tests\`
- Make changes directly to the code on this branch
- After making changes, commit and push them to the branch
- Be concise in your responses as they will be posted back to the GitHub PR

${expectedReplyDelivery}`);
	});

	it("gives review sessions the same reply ownership without losing reviewer feedback", () => {
		edgeWorker = createWorker(true);
		expect(
			(edgeWorker as any).buildGitHubChangeRequestSystemPrompt(
				createPrReviewEvent(),
				"fix-tests",
				"Fix the error handling.",
			),
		).toBe(`You are working on a GitHub Pull Request that has received a change request review.

## Context
- **Repository**: testorg/my-repo
- **PR**: #42 - Fix failing tests
- **Branch**: fix-tests
- **Reviewer**: @reviewer
- **Review URL**: https://github.com/testorg/my-repo/pull/42#pullrequestreview-777

## Reviewer Feedback
Fix the error handling.

## Instructions
- Read the PR diff and the reviewer's feedback above to understand all requested changes
- You are already checked out on the PR branch \`fix-tests\`
- Address all the reviewer's feedback and make the necessary changes
- After making changes, commit and push them to the branch
- Respond with a concise summary of the changes you made

${expectedReplyDelivery}`);
	});

	it("finishes an already resolved queued Codex request without another runner or summary", async () => {
		const runner = configureReplyRunner("success");
		mockGitHubCommentService.isReviewFullyResolved.mockResolvedValue(true);
		(edgeWorker as any).activeGitHubPrSessions.add("github:testorg/my-repo#42");
		await (edgeWorker as any).handleGitHubWebhook(codexRequest());
		expect(
			mockGitHubCommentService.isReviewFullyResolved,
		).not.toHaveBeenCalled();
		(edgeWorker as any).advanceGitHubPrQueue("github:testorg/my-repo#42");
		await vi.waitFor(() =>
			expect(mockGitHubCommentService.deleteReaction).toHaveBeenCalled(),
		);
		expect(mockGitHubCommentService.isReviewFullyResolved).toHaveBeenCalledWith(
			expect.objectContaining({ pullNumber: 42, reviewId: 5265084414 }),
		);
		expect(runner.start).not.toHaveBeenCalled();
		expect(
			mockAgentSessionManager.createCyrusAgentSession,
		).not.toHaveBeenCalled();
		expect(mockGitHubCommentService.postIssueComment).not.toHaveBeenCalled();
		expect(
			mockGitHubCommentService.addReaction.mock.calls.map(
				([p]: any[]) => p.content,
			),
		).toEqual(["eyes", "eyes", "+1"]);
	});

	it.each([
		false,
		new Error("GitHub unavailable"),
	])("still executes a queued review when completion is unproven (%s)", async (resolution) => {
		const runner = configureReplyRunner("success");
		if (resolution instanceof Error)
			mockGitHubCommentService.isReviewFullyResolved.mockRejectedValue(
				resolution,
			);
		else
			mockGitHubCommentService.isReviewFullyResolved.mockResolvedValue(
				resolution,
			);
		await (edgeWorker as any).handleGitHubWebhook(codexRequest(), true);
		expect(runner.start).toHaveBeenCalledOnce();
		expect(mockGitHubCommentService.postIssueComment).toHaveBeenCalledOnce();
	});

	it("does not suppress a human request that references an already resolved review", async () => {
		const runner = configureReplyRunner("success");
		const event = codexRequest();
		event.payload.comment.user.login = "maintainer";
		mockGitHubCommentService.isReviewFullyResolved.mockResolvedValue(true);
		await (edgeWorker as any).handleGitHubWebhook(event, true);
		expect(
			mockGitHubCommentService.isReviewFullyResolved,
		).not.toHaveBeenCalled();
		expect(runner.start).toHaveBeenCalledOnce();
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
