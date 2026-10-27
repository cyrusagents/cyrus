import { LinearClient } from "@linear/sdk";
import type {
	LinearAgentSessionCreatedWebhook,
	LinearAgentSessionPromptedWebhook,
} from "cyrus-core";
import { LinearEventTransport } from "cyrus-linear-event-transport";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager.js";
import { EdgeWorker } from "../src/EdgeWorker.js";
import { SharedApplicationServer } from "../src/SharedApplicationServer.js";
import type { EdgeWorkerConfig, RepositoryConfig } from "../src/types.js";
import { TEST_CYRUS_HOME } from "./test-dirs.js";

vi.mock("fs/promises");
vi.mock("@linear/sdk");
vi.mock("cyrus-linear-event-transport");
vi.mock("../src/AgentSessionManager.js");
vi.mock("../src/SharedApplicationServer.js");
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
 * Opt-in per-issue session exclusion.
 *
 * A delegation and an @mention landing seconds apart start two runners on one
 * issue, sharing a worktree. With `singleSessionPerIssue` enabled the second
 * Linear-triggered start forwards its prompt to the live session instead of
 * starting a second runner. Default-off behaviour is unchanged.
 */
describe("EdgeWorker - singleSessionPerIssue", () => {
	let edgeWorker: EdgeWorker;
	let mockAgentSessionManager: any;

	const ISSUE_ID = "issue-123";
	const LIVE_SESSION_ID = "live-session-1";

	const mockRepository: RepositoryConfig = {
		id: "test-repo",
		name: "Test Repo",
		repositoryPath: "/test/repo",
		workspaceBaseDir: "/test/workspaces",
		baseBranch: "main",
		linearWorkspaceId: "test-workspace",
		isActive: true,
		allowedTools: ["Read", "Edit"],
	};

	const liveSession = {
		id: LIVE_SESSION_ID,
		status: "active",
		issueId: ISSUE_ID,
		issueContext: {
			trackerId: "linear",
			issueId: ISSUE_ID,
			issueIdentifier: "TEST-123",
		},
		workspace: { path: "/test/workspaces/TEST-123", isGitWorktree: true },
	};

	function buildWorker(singleSessionPerIssue: boolean | undefined): EdgeWorker {
		const config: EdgeWorkerConfig = {
			proxyUrl: "http://localhost:3000",
			cyrusHome: TEST_CYRUS_HOME,
			repositories: [mockRepository],
			linearWorkspaces: {
				"test-workspace": { linearToken: "test-token" },
			},
			...(singleSessionPerIssue === undefined ? {} : { singleSessionPerIssue }),
			handlers: {
				createWorkspace: vi.fn().mockResolvedValue({
					path: "/test/workspaces/TEST-123",
					isGitWorktree: false,
				}),
			},
		};

		const worker = new EdgeWorker(config);
		(worker as any).repositories.set(mockRepository.id, mockRepository);
		(worker as any).agentSessionManager = mockAgentSessionManager;
		(worker as any).sessionRepositories.set(LIVE_SESSION_ID, mockRepository.id);
		(worker as any).issueTrackers.set("test-workspace", {
			getClient: vi.fn().mockReturnValue({}),
			fetchIssue: vi.fn().mockResolvedValue({
				id: ISSUE_ID,
				identifier: "TEST-123",
				title: "Test Issue",
				branchName: "test-123",
			}),
			fetchComment: vi.fn().mockResolvedValue(null),
			createAgentActivity: vi.fn().mockResolvedValue({ success: true }),
		});
		return worker;
	}

	function createdWebhook(sessionId: string): LinearAgentSessionCreatedWebhook {
		return {
			type: "AgentSessionEvent",
			action: "created",
			createdAt: "2026-05-20T10:17:13.079Z",
			organizationId: "test-workspace",
			agentSession: {
				id: sessionId,
				issue: {
					id: ISSUE_ID,
					identifier: "TEST-123",
					title: "Test Issue",
					description: "Issue description",
				},
				comment: {
					id: "comment-123",
					body: "Also please update the README",
				},
			},
		} as LinearAgentSessionCreatedWebhook;
	}

	function promptedWebhook(
		sessionId: string,
	): LinearAgentSessionPromptedWebhook {
		return {
			type: "AgentSessionEvent",
			action: "prompted",
			createdAt: "2026-05-20T10:17:13.079Z",
			organizationId: "test-workspace",
			agentSession: {
				id: sessionId,
				issue: {
					id: ISSUE_ID,
					identifier: "TEST-123",
					title: "Test Issue",
				},
			},
			agentActivity: {
				content: { body: "Also please update the README" },
				sourceCommentId: "comment-456",
			},
		} as unknown as LinearAgentSessionPromptedWebhook;
	}

	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});

		mockAgentSessionManager = {
			getSession: vi.fn().mockReturnValue(null),
			getSessionsByIssueId: vi.fn().mockReturnValue([]),
			getActiveSessionsByIssueId: vi.fn().mockReturnValue([]),
			createCyrusAgentSession: vi.fn(),
			createResponseActivity: vi.fn().mockResolvedValue(undefined),
			serializeState: vi.fn().mockReturnValue({ sessions: {}, entries: {} }),
			restoreState: vi.fn(),
			setActivitySink: vi.fn(),
			on: vi.fn(),
		};
		vi.mocked(AgentSessionManager).mockImplementation(function () {
			return mockAgentSessionManager;
		});

		vi.mocked(SharedApplicationServer).mockImplementation(function () {
			return {
				start: vi.fn().mockResolvedValue(undefined),
				stop: vi.fn().mockResolvedValue(undefined),
				getFastifyInstance: vi.fn().mockReturnValue({ post: vi.fn() }),
				getWebhookUrl: vi.fn().mockReturnValue("http://localhost:3456/webhook"),
				registerOAuthCallbackHandler: vi.fn(),
			} as any;
		});

		vi.mocked(LinearEventTransport).mockImplementation(function () {
			return {
				register: vi.fn(),
				on: vi.fn(),
				removeAllListeners: vi.fn(),
			} as any;
		});

		vi.mocked(LinearClient).mockImplementation(function () {
			return {
				users: { me: vi.fn().mockResolvedValue({ id: "user-123" }) },
			} as any;
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("delegation path (AgentSessionEvent.created)", () => {
		function arrange(singleSessionPerIssue: boolean | undefined) {
			edgeWorker = buildWorker(singleSessionPerIssue);
			const routeSpy = vi
				.spyOn(
					(edgeWorker as any).repositoryRouter,
					"determineRepositoryForWebhook",
				)
				.mockResolvedValue({
					type: "selected",
					repositories: [mockRepository],
				});
			const initializeSpy = vi
				.spyOn(edgeWorker as any, "initializeAgentRunner")
				.mockResolvedValue(undefined);
			const forwardSpy = vi
				.spyOn(edgeWorker as any, "handlePromptWithStreamingCheck")
				.mockResolvedValue(false);
			const thoughtSpy = vi
				.spyOn((edgeWorker as any).activityPoster, "postThoughtActivity")
				.mockResolvedValue(undefined);
			return { routeSpy, initializeSpy, forwardSpy, thoughtSpy };
		}

		it("starts a second runner when the option is off", async () => {
			const { initializeSpy, forwardSpy } = arrange(undefined);
			mockAgentSessionManager.getActiveSessionsByIssueId.mockReturnValue([
				liveSession,
			]);

			await (edgeWorker as any).handleAgentSessionCreatedWebhook(
				createdWebhook("second-session-1"),
				[mockRepository],
			);

			expect(initializeSpy).toHaveBeenCalledOnce();
			expect(forwardSpy).not.toHaveBeenCalled();
		});

		it("starts a runner when the option is on and nothing is live", async () => {
			const { initializeSpy, forwardSpy } = arrange(true);
			mockAgentSessionManager.getActiveSessionsByIssueId.mockReturnValue([]);

			await (edgeWorker as any).handleAgentSessionCreatedWebhook(
				createdWebhook("first-session-1"),
				[mockRepository],
			);

			expect(initializeSpy).toHaveBeenCalledOnce();
			expect(forwardSpy).not.toHaveBeenCalled();
		});

		it("forwards to the live session instead of starting a second runner", async () => {
			const { initializeSpy, forwardSpy, thoughtSpy } = arrange(true);
			mockAgentSessionManager.getActiveSessionsByIssueId.mockReturnValue([
				liveSession,
			]);

			await (edgeWorker as any).handleAgentSessionCreatedWebhook(
				createdWebhook("second-session-1"),
				[mockRepository],
			);

			expect(initializeSpy).not.toHaveBeenCalled();

			expect(forwardSpy).toHaveBeenCalledOnce();
			const forwardArgs = forwardSpy.mock.calls[0]!;
			expect(forwardArgs[0]).toBe(liveSession);
			expect(forwardArgs[1]).toBe(mockRepository);
			expect(forwardArgs[2]).toBe(LIVE_SESSION_ID);
			expect(forwardArgs[4]).toBe("Also please update the README");

			expect(thoughtSpy).toHaveBeenCalledWith(
				"second-session-1",
				"test-workspace",
				`Forwarded to the session already working on TEST-123 (${LIVE_SESSION_ID}).`,
			);
			expect(
				mockAgentSessionManager.createResponseActivity,
			).toHaveBeenCalledWith(
				"second-session-1",
				expect.stringContaining("TEST-123"),
			);
		});

		it("ignores the live session when it is the session being started", async () => {
			const { initializeSpy, forwardSpy } = arrange(true);
			mockAgentSessionManager.getActiveSessionsByIssueId.mockReturnValue([
				{ ...liveSession, id: "same-session-1" },
			]);

			await (edgeWorker as any).handleAgentSessionCreatedWebhook(
				createdWebhook("same-session-1"),
				[mockRepository],
			);

			expect(initializeSpy).toHaveBeenCalledOnce();
			expect(forwardSpy).not.toHaveBeenCalled();
		});

		it("starts a runner when the live session has no repository mapping", async () => {
			const { initializeSpy, forwardSpy } = arrange(true);
			(edgeWorker as any).sessionRepositories.delete(LIVE_SESSION_ID);
			mockAgentSessionManager.getActiveSessionsByIssueId.mockReturnValue([
				liveSession,
			]);

			await (edgeWorker as any).handleAgentSessionCreatedWebhook(
				createdWebhook("second-session-1"),
				[mockRepository],
			);

			expect(forwardSpy).not.toHaveBeenCalled();
			expect(initializeSpy).toHaveBeenCalledOnce();
		});
	});

	describe("mention path (AgentSessionEvent.prompted, new session)", () => {
		function arrange(singleSessionPerIssue: boolean | undefined) {
			edgeWorker = buildWorker(singleSessionPerIssue);
			const createSpy = vi
				.spyOn(edgeWorker as any, "createCyrusAgentSession")
				.mockResolvedValue({
					session: {
						id: "second-session-2",
						status: "active",
						workspace: {
							path: "/test/workspaces/TEST-123",
							isGitWorktree: false,
						},
						agentRunner: null,
					},
					fullIssue: {
						id: ISSUE_ID,
						identifier: "TEST-123",
						title: "Test Issue",
					},
				});
			const forwardSpy = vi
				.spyOn(edgeWorker as any, "handlePromptWithStreamingCheck")
				.mockResolvedValue(false);
			vi.spyOn(
				edgeWorker as any,
				"postInstantPromptedAcknowledgment",
			).mockResolvedValue(undefined);
			const thoughtSpy = vi
				.spyOn((edgeWorker as any).activityPoster, "postThoughtActivity")
				.mockResolvedValue(undefined);
			return { createSpy, forwardSpy, thoughtSpy };
		}

		it("creates a second session when the option is off", async () => {
			const { createSpy } = arrange(undefined);
			mockAgentSessionManager.getActiveSessionsByIssueId.mockReturnValue([
				liveSession,
			]);

			await (edgeWorker as any).handleNormalPromptedActivity(
				promptedWebhook("second-session-2"),
				[mockRepository],
			);

			expect(createSpy).toHaveBeenCalledOnce();
		});

		it("forwards to the live session instead of creating a second one", async () => {
			const { createSpy, forwardSpy, thoughtSpy } = arrange(true);
			mockAgentSessionManager.getActiveSessionsByIssueId.mockReturnValue([
				liveSession,
			]);

			await (edgeWorker as any).handleNormalPromptedActivity(
				promptedWebhook("second-session-2"),
				[mockRepository],
			);

			expect(createSpy).not.toHaveBeenCalled();

			expect(forwardSpy).toHaveBeenCalledOnce();
			const forwardArgs = forwardSpy.mock.calls[0]!;
			expect(forwardArgs[0]).toBe(liveSession);
			expect(forwardArgs[2]).toBe(LIVE_SESSION_ID);
			expect(forwardArgs[4]).toBe("Also please update the README");

			expect(thoughtSpy).toHaveBeenCalledWith(
				"second-session-2",
				"test-workspace",
				`Forwarded to the session already working on TEST-123 (${LIVE_SESSION_ID}).`,
			);
			expect(
				mockAgentSessionManager.createResponseActivity,
			).toHaveBeenCalledWith(
				"second-session-2",
				expect.stringContaining("TEST-123"),
			);
		});

		it("leaves a prompt on an already-live session alone", async () => {
			const { createSpy, forwardSpy } = arrange(true);
			mockAgentSessionManager.getSession.mockReturnValue(liveSession);
			mockAgentSessionManager.getActiveSessionsByIssueId.mockReturnValue([
				liveSession,
			]);

			await (edgeWorker as any).handleNormalPromptedActivity(
				promptedWebhook(LIVE_SESSION_ID),
				[mockRepository],
			);

			expect(createSpy).not.toHaveBeenCalled();
			expect(forwardSpy).toHaveBeenCalledOnce();
			// Forwarded through the normal continuation path, not the guard:
			// the session prompted IS the live session.
			expect(forwardSpy.mock.calls[0]![2]).toBe(LIVE_SESSION_ID);
			expect(
				mockAgentSessionManager.createResponseActivity,
			).not.toHaveBeenCalled();
		});
	});
});
