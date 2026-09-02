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

describe("EdgeWorker - duplicate AgentSessionEvent.created webhook deliveries", () => {
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

	const buildWebhook = (sessionId: string): LinearAgentSessionCreatedWebhook =>
		({
			type: "AgentSessionEvent",
			action: "created",
			createdAt: "2026-05-20T10:17:13.079Z",
			organizationId: "test-workspace",
			agentSession: {
				id: sessionId,
				issue: {
					id: "issue-123",
					identifier: "TEST-123",
					title: "Test issue",
					description: "Test description",
				},
				comment: {
					id: "comment-123",
					body: "This thread is for an agent session",
				},
			},
		}) as LinearAgentSessionCreatedWebhook;

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

		vi.spyOn(
			(edgeWorker as any).repositoryRouter,
			"determineRepositoryForWebhook",
		).mockResolvedValue({
			type: "selected",
			repositories: [mockRepository],
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("initializes the agent runner only once when the same created webhook is redelivered", async () => {
		const initializeSpy = vi
			.spyOn(edgeWorker as any, "initializeAgentRunner")
			.mockResolvedValue(undefined);

		const webhook = buildWebhook("session-redelivered");

		await (edgeWorker as any).handleAgentSessionCreatedWebhook(webhook, [
			mockRepository,
		]);
		// Linear retries deliveries it considers failed (~1min / ~1hr backoff)
		await (edgeWorker as any).handleAgentSessionCreatedWebhook(webhook, [
			mockRepository,
		]);

		expect(initializeSpy).toHaveBeenCalledOnce();
	});

	it("initializes the agent runner only once when duplicate deliveries arrive concurrently", async () => {
		const initializeSpy = vi
			.spyOn(edgeWorker as any, "initializeAgentRunner")
			.mockResolvedValue(undefined);

		const webhook = buildWebhook("session-concurrent");

		// Second delivery lands while the first is still being processed
		// (before the first has finished routing / tracking the session)
		await Promise.all([
			(edgeWorker as any).handleAgentSessionCreatedWebhook(webhook, [
				mockRepository,
			]),
			(edgeWorker as any).handleAgentSessionCreatedWebhook(webhook, [
				mockRepository,
			]),
		]);

		expect(initializeSpy).toHaveBeenCalledOnce();
	});

	it("ignores a created webhook redelivered for a session restored from persisted state", async () => {
		// Simulate a restart: the session was created in a previous run and
		// restored from disk, then Linear retries the created delivery
		edgeWorker.restoreMappings({
			agentSessions: {
				"session-restored": { id: "session-restored" },
			},
			agentSessionEntries: { "session-restored": [] },
		} as any);

		const initializeSpy = vi
			.spyOn(edgeWorker as any, "initializeAgentRunner")
			.mockResolvedValue(undefined);

		await (edgeWorker as any).handleAgentSessionCreatedWebhook(
			buildWebhook("session-restored"),
			[mockRepository],
		);

		expect(initializeSpy).not.toHaveBeenCalled();
	});

	it("still processes created webhooks for distinct agent sessions", async () => {
		const initializeSpy = vi
			.spyOn(edgeWorker as any, "initializeAgentRunner")
			.mockResolvedValue(undefined);

		await (edgeWorker as any).handleAgentSessionCreatedWebhook(
			buildWebhook("session-a"),
			[mockRepository],
		);
		await (edgeWorker as any).handleAgentSessionCreatedWebhook(
			buildWebhook("session-b"),
			[mockRepository],
		);

		expect(initializeSpy).toHaveBeenCalledTimes(2);
	});
});
