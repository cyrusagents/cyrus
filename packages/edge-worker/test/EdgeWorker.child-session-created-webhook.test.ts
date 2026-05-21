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
		PersistenceManager: vi.fn().mockImplementation(() => ({
			loadEdgeWorkerState: vi.fn().mockResolvedValue(null),
			saveEdgeWorkerState: vi.fn().mockResolvedValue(undefined),
		})),
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
			serializeState: vi.fn().mockReturnValue({ sessions: {}, entries: {} }),
			restoreState: vi.fn(),
			on: vi.fn(),
		};
		vi.mocked(AgentSessionManager).mockImplementation(
			() => mockAgentSessionManager,
		);

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
						me: vi.fn().mockResolvedValue({ id: "user-123" }),
					},
				}) as any,
		);

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
});
