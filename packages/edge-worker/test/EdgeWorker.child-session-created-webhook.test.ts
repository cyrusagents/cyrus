import { LinearClient } from "@linear/sdk";
import type { LinearAgentSessionCreatedWebhook } from "cyrus-core";
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

describe("EdgeWorker - child AgentSessionEvent.created webhooks", () => {
	let edgeWorker: EdgeWorker;
	let mockAgentSessionManager: any;

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

	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});

		mockAgentSessionManager = {
			createCyrusAgentSession: vi.fn(),
			getSessionsByIssueId: vi.fn().mockReturnValue([]),
			serializeState: vi.fn().mockReturnValue({ sessions: {}, entries: {} }),
			restoreState: vi.fn(),
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
				users: {
					me: vi.fn().mockResolvedValue({ id: "user-123" }),
				},
			} as any;
		});

		const mockConfig: EdgeWorkerConfig = {
			proxyUrl: "http://localhost:3000",
			cyrusHome: TEST_CYRUS_HOME,
			repositories: [mockRepository],
			linearWorkspaces: {
				"test-workspace": { linearToken: "test-token" },
			},
			handlers: {
				createWorkspace: vi.fn().mockResolvedValue({
					path: "/test/workspaces/TEST-123",
					isGitWorktree: false,
				}),
			},
		};

		edgeWorker = new EdgeWorker(mockConfig);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("starts a created webhook for a child session already mapped to a parent", async () => {
		const childSessionId = "child-session-123";
		const parentSessionId = "parent-session-456";
		(edgeWorker as any).globalSessionRegistry.setParentSession(
			childSessionId,
			parentSessionId,
		);

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

		const webhook: LinearAgentSessionCreatedWebhook = {
			type: "AgentSessionEvent",
			action: "created",
			createdAt: "2026-05-20T10:17:13.079Z",
			organizationId: "test-workspace",
			agentSession: {
				id: childSessionId,
				issue: {
					id: "issue-123",
					identifier: "TEST-123",
					title: "Child issue",
					description: "Read-only child task",
				},
				comment: {
					id: "comment-123",
					body: "This thread is for an agent session",
				},
			},
		} as LinearAgentSessionCreatedWebhook;

		await (edgeWorker as any).handleAgentSessionCreatedWebhook(webhook, [
			mockRepository,
		]);

		expect(routeSpy).toHaveBeenCalledOnce();
		expect(initializeSpy).toHaveBeenCalledWith(
			webhook.agentSession,
			[mockRepository],
			"test-workspace",
			undefined,
			"This thread is for an agent session",
			undefined,
			undefined,
		);
	});
	describe("linking a child session to its parent issue's session", () => {
		const childSessionId = "child-session-123";
		const childIssueId = "child-issue-123";
		const parentIssueId = "parent-issue-456";

		const makeWebhook = (): LinearAgentSessionCreatedWebhook =>
			({
				type: "AgentSessionEvent",
				action: "created",
				createdAt: "2026-05-20T10:17:13.079Z",
				organizationId: "test-workspace",
				agentSession: {
					id: childSessionId,
					issue: {
						id: childIssueId,
						identifier: "TEST-124",
						title: "Child issue",
						description: "Delegated sub-issue",
					},
					comment: {
						id: "comment-123",
						body: "This thread is for an agent session",
					},
				},
			}) as LinearAgentSessionCreatedWebhook;

		const makeParentSession = (
			id: string,
			status: string,
			updatedAt: number,
		) => ({
			id,
			status,
			updatedAt,
			issueContext: {
				trackerId: "linear",
				issueId: parentIssueId,
				issueIdentifier: "TEST-100",
			},
		});

		let initializeSpy: ReturnType<typeof vi.spyOn>;

		beforeEach(() => {
			vi.spyOn(
				(edgeWorker as any).repositoryRouter,
				"determineRepositoryForWebhook",
			).mockResolvedValue({
				type: "selected",
				repositories: [mockRepository],
			});
			initializeSpy = vi
				.spyOn(edgeWorker as any, "initializeAgentRunner")
				.mockResolvedValue(undefined);
			vi.spyOn(
				edgeWorker as any,
				"checkBlockedByDependencies",
			).mockResolvedValue({
				blocked: false,
				blockingIssueIds: [],
				blockingIdentifiers: [],
			});
		});

		it("links the child to the parent issue's session even when that session is complete", async () => {
			vi.spyOn(edgeWorker, "fetchFullIssueDetails").mockResolvedValue({
				id: childIssueId,
				identifier: "TEST-124",
				parent: Promise.resolve({ id: parentIssueId, identifier: "TEST-100" }),
			} as any);
			mockAgentSessionManager.getSessionsByIssueId.mockImplementation(
				(issueId: string) =>
					issueId === parentIssueId
						? [makeParentSession("parent-session-456", "complete", 1000)]
						: [],
			);

			await (edgeWorker as any).handleAgentSessionCreatedWebhook(
				makeWebhook(),
				[mockRepository],
			);

			expect(
				(edgeWorker as any).globalSessionRegistry.getParentSessionId(
					childSessionId,
				),
			).toBe("parent-session-456");
			expect(initializeSpy).toHaveBeenCalledOnce();
		});

		it("prefers the most recently updated session on the parent issue", async () => {
			vi.spyOn(edgeWorker, "fetchFullIssueDetails").mockResolvedValue({
				id: childIssueId,
				identifier: "TEST-124",
				parent: Promise.resolve({ id: parentIssueId, identifier: "TEST-100" }),
			} as any);
			mockAgentSessionManager.getSessionsByIssueId.mockReturnValue([
				makeParentSession("parent-session-old", "complete", 1000),
				makeParentSession("parent-session-new", "complete", 2000),
				makeParentSession("parent-session-mid", "active", 1500),
			]);

			await (edgeWorker as any).handleAgentSessionCreatedWebhook(
				makeWebhook(),
				[mockRepository],
			);

			expect(
				(edgeWorker as any).globalSessionRegistry.getParentSessionId(
					childSessionId,
				),
			).toBe("parent-session-new");
		});

		it("does not link when the issue has no parent", async () => {
			vi.spyOn(edgeWorker, "fetchFullIssueDetails").mockResolvedValue({
				id: childIssueId,
				identifier: "TEST-124",
				parent: Promise.resolve(null),
			} as any);

			await (edgeWorker as any).handleAgentSessionCreatedWebhook(
				makeWebhook(),
				[mockRepository],
			);

			expect(
				(edgeWorker as any).globalSessionRegistry.getParentSessionId(
					childSessionId,
				),
			).toBeUndefined();
			expect(
				mockAgentSessionManager.getSessionsByIssueId,
			).not.toHaveBeenCalled();
			expect(initializeSpy).toHaveBeenCalledOnce();
		});

		it("does not link when the parent issue has no Cyrus session", async () => {
			vi.spyOn(edgeWorker, "fetchFullIssueDetails").mockResolvedValue({
				id: childIssueId,
				identifier: "TEST-124",
				parent: Promise.resolve({ id: parentIssueId, identifier: "TEST-100" }),
			} as any);
			mockAgentSessionManager.getSessionsByIssueId.mockReturnValue([]);

			await (edgeWorker as any).handleAgentSessionCreatedWebhook(
				makeWebhook(),
				[mockRepository],
			);

			expect(
				(edgeWorker as any).globalSessionRegistry.getParentSessionId(
					childSessionId,
				),
			).toBeUndefined();
			expect(initializeSpy).toHaveBeenCalledOnce();
		});

		it("does not overwrite an existing parent mapping", async () => {
			(edgeWorker as any).globalSessionRegistry.setParentSession(
				childSessionId,
				"restored-parent-session",
			);
			const fetchSpy = vi
				.spyOn(edgeWorker, "fetchFullIssueDetails")
				.mockResolvedValue({
					id: childIssueId,
					identifier: "TEST-124",
					parent: Promise.resolve({
						id: parentIssueId,
						identifier: "TEST-100",
					}),
				} as any);
			mockAgentSessionManager.getSessionsByIssueId.mockReturnValue([
				makeParentSession("parent-session-456", "complete", 1000),
			]);

			await (edgeWorker as any).handleAgentSessionCreatedWebhook(
				makeWebhook(),
				[mockRepository],
			);

			expect(
				(edgeWorker as any).globalSessionRegistry.getParentSessionId(
					childSessionId,
				),
			).toBe("restored-parent-session");
			expect(fetchSpy).not.toHaveBeenCalled();
		});

		it("still starts the session when the parent lookup fails", async () => {
			vi.spyOn(edgeWorker, "fetchFullIssueDetails").mockRejectedValue(
				new Error("Linear API unavailable"),
			);

			await (edgeWorker as any).handleAgentSessionCreatedWebhook(
				makeWebhook(),
				[mockRepository],
			);

			expect(
				(edgeWorker as any).globalSessionRegistry.getParentSessionId(
					childSessionId,
				),
			).toBeUndefined();
			expect(initializeSpy).toHaveBeenCalledOnce();
		});

		it("links a blocked child before parking it", async () => {
			vi.spyOn(edgeWorker, "fetchFullIssueDetails").mockResolvedValue({
				id: childIssueId,
				identifier: "TEST-124",
				parent: Promise.resolve({ id: parentIssueId, identifier: "TEST-100" }),
			} as any);
			mockAgentSessionManager.getSessionsByIssueId.mockReturnValue([
				makeParentSession("parent-session-456", "complete", 1000),
			]);
			vi.spyOn(
				edgeWorker as any,
				"checkBlockedByDependencies",
			).mockResolvedValue({
				blocked: true,
				blockingIssueIds: ["blocker-issue"],
				blockingIdentifiers: ["TEST-99"],
			});
			vi.spyOn(
				(edgeWorker as any).activityPoster,
				"postThoughtActivity",
			).mockResolvedValue(undefined);

			await (edgeWorker as any).handleAgentSessionCreatedWebhook(
				makeWebhook(),
				[mockRepository],
			);

			expect(
				(edgeWorker as any).globalSessionRegistry.getParentSessionId(
					childSessionId,
				),
			).toBe("parent-session-456");
			expect((edgeWorker as any).parkedSessions.has(childIssueId)).toBe(true);
			expect(initializeSpy).not.toHaveBeenCalled();
		});
	});
});
