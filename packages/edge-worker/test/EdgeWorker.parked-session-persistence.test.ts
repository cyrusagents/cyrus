import { LinearClient } from "@linear/sdk";
import { ClaudeRunner } from "cyrus-claude-runner";
import { LinearEventTransport } from "cyrus-linear-event-transport";
import { createCyrusToolsServer } from "cyrus-mcp-tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager.js";
import { EdgeWorker } from "../src/EdgeWorker.js";
import { SharedApplicationServer } from "../src/SharedApplicationServer.js";
import type { EdgeWorkerConfig, RepositoryConfig } from "../src/types.js";
import { TEST_CYRUS_HOME } from "./test-dirs.js";

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
 * A session parked on a blocked-by dependency used to live only in memory, so
 * any restart dropped it: the blocker's later state-change webhook found an
 * empty map and did nothing, and the issue kept a "will start automatically"
 * promise with no way to clear it but a re-prompt.
 */
describe("EdgeWorker - parked session persistence", () => {
	const repoA: RepositoryConfig = {
		id: "repo-a",
		name: "Repo A",
		repositoryPath: "/test/repo-a",
		workspaceBaseDir: "/test/workspaces",
		baseBranch: "main",
		linearWorkspaceId: "test-workspace",
		isActive: true,
		teamKeys: ["TEST"],
	};
	const repoB: RepositoryConfig = {
		...repoA,
		id: "repo-b",
		name: "Repo B",
		repositoryPath: "/test/repo-b",
	};

	const parkedAgentSession = {
		id: "agent-session-1",
		issue: { id: "issue-blocked", identifier: "TEST-2", title: "Blocked" },
	};

	let mockConfig: EdgeWorkerConfig;

	beforeEach(() => {
		vi.clearAllMocks();

		vi.mocked(createCyrusToolsServer).mockImplementation(
			() => ({ server: {} }) as any,
		);
		vi.mocked(ClaudeRunner).mockImplementation(function () {
			return {
				supportsStreamingInput: true,
				startStreaming: vi.fn().mockResolvedValue({ sessionId: "claude-1" }),
				stop: vi.fn(),
				isStreaming: vi.fn().mockReturnValue(false),
				isRunning: vi.fn().mockReturnValue(false),
			};
		} as any);
		vi.mocked(AgentSessionManager).mockImplementation(function () {
			return {
				serializeState: vi.fn().mockReturnValue({ sessions: {}, entries: {} }),
				restoreState: vi.fn(),
				setActivitySink: vi.fn(),
				on: vi.fn(),
			};
		} as any);
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
			return { register: vi.fn(), on: vi.fn(), removeAllListeners: vi.fn() };
		} as any);
		vi.mocked(LinearClient).mockImplementation(function () {
			return { users: { me: vi.fn().mockResolvedValue({ id: "user-1" }) } };
		} as any);

		mockConfig = {
			proxyUrl: "http://localhost:3000",
			cyrusHome: TEST_CYRUS_HOME,
			repositories: [repoA, repoB],
			linearWorkspaces: { "test-workspace": { linearToken: "test-token" } },
			handlers: {
				createWorkspace: vi.fn().mockResolvedValue({
					path: "/test/workspaces/TEST-2",
					isGitWorktree: false,
				}),
			},
		};
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	function park(
		worker: EdgeWorker,
		repositories: RepositoryConfig[],
		blockingIssueIds = ["issue-blocker"],
	) {
		(worker as any).parkedSessions.set(parkedAgentSession.issue.id, {
			agentSession: parkedAgentSession,
			repositories,
			linearWorkspaceId: "test-workspace",
			commentBody: "please do this",
			baseBranchOverrides: new Map([["repo-a", "develop"]]),
			routingMethod: "label",
			blockingIssueIds,
		});
	}

	function restart(state: ReturnType<EdgeWorker["serializeMappings"]>) {
		const worker = new EdgeWorker(mockConfig);
		worker.restoreMappings(state);
		return worker;
	}

	/** Report `completedIssueId` as completed, and deliver its state change. */
	async function completeBlocker(worker: EdgeWorker, completedIssueId: string) {
		(worker as any).issueTrackers.set("test-workspace", {
			fetchIssue: vi.fn().mockResolvedValue({
				id: completedIssueId,
				identifier: "TEST-1",
				state: Promise.resolve({ type: "completed" }),
			}),
		});

		await (worker as any).handleIssueStateChange({
			type: "Issue",
			action: "update",
			organizationId: "test-workspace",
			data: {
				id: completedIssueId,
				identifier: "TEST-1",
				stateId: "state-done",
			},
			updatedFrom: { stateId: "state-doing" },
		});
	}

	it("round-trips a parked session through a restart", () => {
		const before = new EdgeWorker(mockConfig);
		park(before, [repoA]);

		const state = before.serializeMappings();
		expect(state.parkedSessions?.["issue-blocked"]).toMatchObject({
			linearWorkspaceId: "test-workspace",
			repositoryIds: ["repo-a"],
			commentBody: "please do this",
			baseBranchOverrides: { "repo-a": "develop" },
			routingMethod: "label",
			blockingIssueIds: ["issue-blocker"],
		});

		const restored = (restart(state) as any).parkedSessions.get(
			"issue-blocked",
		);
		expect(restored.repositories).toEqual([repoA]);
		expect(restored.blockingIssueIds).toEqual(["issue-blocker"]);
		expect(restored.baseBranchOverrides).toBeInstanceOf(Map);
		expect(restored.baseBranchOverrides.get("repo-a")).toBe("develop");
	});

	it("keeps the stored repository order, so the primary repo survives", () => {
		const before = new EdgeWorker(mockConfig);
		// Routed to B first — the reverse of the order they appear in config
		park(before, [repoB, repoA]);

		const restored = (
			restart(before.serializeMappings()) as any
		).parkedSessions.get("issue-blocked");

		expect(restored.repositories.map((r: RepositoryConfig) => r.id)).toEqual([
			"repo-b",
			"repo-a",
		]);
	});

	it("wakes a restored session when its blocker completes", async () => {
		const before = new EdgeWorker(mockConfig);
		park(before, [repoA]);

		const after = restart(before.serializeMappings());
		const initializeAgentRunner = vi
			.spyOn(after as any, "initializeAgentRunner")
			.mockResolvedValue(undefined);
		vi.spyOn(
			(after as any).activityPoster,
			"postThoughtActivity",
		).mockResolvedValue(undefined);

		await completeBlocker(after, "issue-blocker");

		expect(initializeAgentRunner).toHaveBeenCalledTimes(1);
		expect(initializeAgentRunner).toHaveBeenCalledWith(
			parkedAgentSession,
			[repoA],
			"test-workspace",
			undefined,
			"please do this",
			expect.any(Map),
			"label",
		);
		expect((after as any).parkedSessions.size).toBe(0);
	});

	it("carries a partly cleared blocker list into the next restart", async () => {
		const worker = new EdgeWorker(mockConfig);
		park(worker, [repoA], ["issue-blocker", "issue-blocker-2"]);
		const initializeAgentRunner = vi
			.spyOn(worker as any, "initializeAgentRunner")
			.mockResolvedValue(undefined);
		const savePersistedState = vi.spyOn(
			worker as any,
			"savePersistedState",
		) as unknown as ReturnType<typeof vi.fn>;

		await completeBlocker(worker, "issue-blocker");

		// One blocker left, so the session stays parked — but the shortened list
		// has to reach disk, or a restart waits on an event that already fired.
		expect(initializeAgentRunner).not.toHaveBeenCalled();
		expect(savePersistedState).toHaveBeenCalled();
		expect(
			(restart(worker.serializeMappings()) as any).parkedSessions.get(
				"issue-blocked",
			).blockingIssueIds,
		).toEqual(["issue-blocker-2"]);
	});

	it("drops a restored session whose repositories are no longer configured", () => {
		const before = new EdgeWorker(mockConfig);
		park(before, [repoA]);
		const state = before.serializeMappings();

		const after = new EdgeWorker({ ...mockConfig, repositories: [] });
		after.restoreMappings(state);

		expect((after as any).parkedSessions.size).toBe(0);
	});

	it("never writes repository credentials into the persisted state", () => {
		const withToken = { ...repoA, linearToken: "secret-token" };
		const worker = new EdgeWorker({
			...mockConfig,
			repositories: [withToken],
		});
		park(worker, [withToken]);

		expect(JSON.stringify(worker.serializeMappings())).not.toContain(
			"secret-token",
		);
	});
});
