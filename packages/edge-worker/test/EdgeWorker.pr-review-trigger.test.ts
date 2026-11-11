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
			addReaction: vi.fn().mockResolvedValue(undefined),
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
	function appEvent() {
		const event = createPrReviewEvent();
		event.payload.review.user = {
			id: 999,
			node_id: "BOT_node",
			type: "Bot",
			login: "reviewer[bot]",
		};
		event.payload.pull_request.user = { id: 111, login: "cyrusagent[bot]" };
		event.payload.repository.owner.type = "Organization";
		return event;
	}
	function allowApp(worker: EdgeWorker) {
		(worker as any).config.githubReviewAppPolicies = [
			{ installationId: "55555", organization: "testorg", appIds: [42] },
		];
	}
	function mockAppIdentity() {
		return vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(
				Response.json({
					data: {
						node: {
							__typename: "Bot",
							databaseId: 999,
							login: "reviewer",
							url: "https://github.com/apps/reviewer",
						},
					},
				}),
			)
			.mockResolvedValueOnce(Response.json({ id: 42, slug: "reviewer" }));
	}
	it("accepts a verified allowlisted app review", async () => {
		edgeWorker = createWorker(true);
		allowApp(edgeWorker);
		mockAppIdentity();
		await (edgeWorker as any).handleGitHubWebhook(appEvent());
		expect(mockGitHubCommentService.postIssueComment).toHaveBeenCalled();
	});
	it("denies apps by default without acknowledgement or identity lookup", async () => {
		edgeWorker = createWorker(true);
		const request = vi.spyOn(globalThis, "fetch");
		await (edgeWorker as any).handleGitHubWebhook(appEvent());
		expect(request).not.toHaveBeenCalled();
		expect(mockGitHubCommentService.postIssueComment).not.toHaveBeenCalled();
	});
	it("does not let an allowed app bypass the disabled PR review trigger", async () => {
		edgeWorker = createWorker(false);
		allowApp(edgeWorker);
		await (edgeWorker as any).handleGitHubWebhook(appEvent());
		expect((edgeWorker as any).resolveGitHubToken).not.toHaveBeenCalled();
		expect(mockGitHubCommentService.postIssueComment).not.toHaveBeenCalled();
	});
	it("denies a verified app that is absent from the allowlist", async () => {
		edgeWorker = createWorker(true);
		allowApp(edgeWorker);
		mockAppIdentity();
		(edgeWorker as any).config.githubReviewAppPolicies[0].appIds = [43];
		await (edgeWorker as any).handleGitHubWebhook(appEvent());
		expect(mockGitHubCommentService.postIssueComment).not.toHaveBeenCalled();
	});
	it("isolates grants by org and installation and prevents self reviews", async () => {
		edgeWorker = createWorker(true);
		allowApp(edgeWorker);
		for (const kind of ["org", "installation", "self"]) {
			const event = appEvent();
			if (kind === "org") event.payload.repository.owner.login = "other";
			if (kind === "installation") event.payload.installation.id = 123;
			if (kind === "self") event.payload.pull_request.user.id = 999;
			await (edgeWorker as any).handleGitHubWebhook(event);
		}
		expect((edgeWorker as any).resolveGitHubToken).not.toHaveBeenCalled();
		expect(mockGitHubCommentService.postIssueComment).not.toHaveBeenCalled();
	});
	it("fails closed on provider errors", async () => {
		edgeWorker = createWorker(true);
		allowApp(edgeWorker);
		vi.spyOn(globalThis, "fetch").mockRejectedValue(
			new Error("Provider unavailable"),
		);
		await (edgeWorker as any).handleGitHubWebhook(appEvent());
		expect(mockGitHubCommentService.postIssueComment).not.toHaveBeenCalled();
	});
	function suggestionEvent() {
		const event = appEvent();
		event.payload.review.state = "commented";
		event.payload.review.body = "Codex review receipt (not the finding)";
		event.payload.pull_request.head.sha = "abc123";
		return event;
	}
	function suggestionWorker() {
		const worker = createWorker(true);
		allowApp(worker);
		(worker as any).config.githubReviewAppPolicies[0].includeSuggestions = true;
		(worker as any).createGitHubWorkspace = vi.fn().mockResolvedValue({
			path: "/test/workspaces/PR-42",
			isGitWorktree: true,
		});
		mockAgentSessionManager.getSession.mockReturnValue({ metadata: {} });
		(worker as any).buildAgentRunnerConfig = vi
			.fn()
			.mockResolvedValue({ config: {}, runnerType: "claude" });
		const runner = {
			start: vi.fn().mockResolvedValue({ sessionId: "suggestion-session" }),
		};
		(worker as any).createRunnerForType = vi.fn().mockReturnValue(runner);
		(worker as any).postGitHubReply = vi.fn().mockResolvedValue(undefined);
		(worker as any).savePersistedState = vi.fn().mockResolvedValue(undefined);
		return { worker, runner };
	}
	function suggestionFindings() {
		return [1, 2].map((id) => ({
			id,
			pull_request_review_id: 777,
			user: { id: 999 },
			commit_id: "abc123",
			path: `file-${id}.ts`,
			line: 10,
			body: `Finding ${id}`,
			html_url: `https://github.com/testorg/my-repo/pull/42#discussion_r${id}`,
		}));
	}
	function mockSuggestion(findings = suggestionFindings()) {
		return vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
			if (String(url).endsWith("/graphql"))
				return Response.json({
					data: {
						node: {
							__typename: "Bot",
							databaseId: 999,
							login: "reviewer",
							url: "https://github.com/apps/reviewer",
						},
					},
				});
			if (String(url).includes("/apps/reviewer"))
				return Response.json({ id: 42, slug: "reviewer" });
			return Response.json(findings);
		});
	}
	it("runs one batch containing both inline findings and deduplicates review deliveries", async () => {
		const { worker, runner } = suggestionWorker();
		mockSuggestion();
		const event = suggestionEvent();
		await Promise.all([
			(worker as any).handleGitHubWebhook(event),
			(worker as any).handleGitHubWebhook({
				...event,
				deliveryId: "retry-delivery",
			}),
		]);
		await (worker as any).handleGitHubWebhook({
			...event,
			deliveryId: "later-retry",
		});
		expect(runner.start).toHaveBeenCalledOnce();
		const prompt = runner.start.mock.calls[0][0];
		expect(prompt).toContain("Finding 1");
		expect(prompt).toContain("Finding 2");
		expect(prompt).toContain("file-2.ts:10");
		expect(prompt).not.toContain("Codex review receipt");
		expect(mockGitHubCommentService.postIssueComment).toHaveBeenCalledOnce();
		expect(
			mockGitHubCommentService.postIssueComment.mock.calls[0][0].body,
		).toContain("review suggestions");
	});
	it("queues a suggestion once, then revalidates and processes it as one batch", async () => {
		const { worker, runner } = suggestionWorker();
		mockSuggestion();
		(worker as any).activeGitHubPrSessions.add("github:testorg/my-repo#42");
		await (worker as any).handleGitHubWebhook(suggestionEvent());
		await (worker as any).handleGitHubWebhook({
			...suggestionEvent(),
			deliveryId: "retry",
		});
		expect(runner.start).not.toHaveBeenCalled();
		expect(
			(worker as any).queuedGitHubPrEvents.get("github:testorg/my-repo#42"),
		).toHaveLength(1);
		(worker as any).advanceGitHubPrQueue("github:testorg/my-repo#42");
		await vi.waitFor(() => expect(runner.start).toHaveBeenCalledOnce());
	});
	it.each([
		"opt-out",
		"trigger-off",
		"other-org",
		"other-installation",
		"human",
		"stale",
		"approved",
		"edited",
		"denied-app",
	])("ignores %s suggestions", async (kind) => {
		const { worker, runner } = suggestionWorker();
		mockSuggestion();
		const event = suggestionEvent();
		if (kind === "opt-out")
			delete (worker as any).config.githubReviewAppPolicies[0]
				.includeSuggestions;
		if (kind === "trigger-off") (worker as any).config.prReviewTrigger = false;
		if (kind === "other-org") event.payload.repository.owner.login = "other";
		if (kind === "other-installation") event.payload.installation.id = 123;
		if (kind === "human") event.payload.review.user.type = "User";
		if (kind === "stale") event.payload.review.commit_id = "old";
		if (kind === "approved") event.payload.review.state = "approved";
		if (kind === "edited") event.payload.action = "edited";
		if (kind === "denied-app")
			(worker as any).config.githubReviewAppPolicies[0].appIds = [43];
		await (worker as any).handleGitHubWebhook(event);
		expect(runner.start).not.toHaveBeenCalled();
		expect(mockGitHubCommentService.postIssueComment).not.toHaveBeenCalled();
	});
	it("ignores empty app reviews, but retries a later delivery if findings become available", async () => {
		const { worker, runner } = suggestionWorker();
		const request = mockSuggestion([]);
		await (worker as any).handleGitHubWebhook(suggestionEvent());
		expect(runner.start).not.toHaveBeenCalled();
		expect(mockGitHubCommentService.postIssueComment).not.toHaveBeenCalled();
		request.mockRestore();
		mockSuggestion();
		await (worker as any).handleGitHubWebhook(suggestionEvent());
		expect(runner.start).toHaveBeenCalledOnce();
	});
});
