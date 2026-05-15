/**
 * Tests for the handleProjectUpdateWebhook behaviour added in Workstream A
 * and tightened by Ray's pre-cloud-migration review:
 *
 *  - B2: cross-agent reply rate-limit (per-project rolling window).
 *  - N4: `update` action only fires when the mention was newly added.
 *  - N1: identity resolution times out instead of hanging on a slow viewer query.
 *
 * Item 6 from Ray's test plan is a manual integration probe (post a real
 * ProjectUpdate against the test agent and tail the log). Not run from here —
 * see workstream-a-review.md test plan addendum #6.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EdgeWorker } from "../src/EdgeWorker.js";
import type { EdgeWorkerConfig, RepositoryConfig } from "../src/types.js";

vi.mock("fs/promises", () => ({
	readFile: vi.fn(),
	writeFile: vi.fn(),
	mkdir: vi.fn(),
	rename: vi.fn(),
	readdir: vi.fn().mockResolvedValue([]),
}));

vi.mock("cyrus-claude-runner");
vi.mock("cyrus-codex-runner");
vi.mock("cyrus-gemini-runner");
vi.mock("cyrus-linear-event-transport");
vi.mock("@linear/sdk");
vi.mock("../src/SharedApplicationServer.js", () => ({
	SharedApplicationServer: vi.fn().mockImplementation(() => ({
		initializeFastify: vi.fn(),
		getFastifyInstance: vi.fn().mockReturnValue({
			get: vi.fn(),
			post: vi.fn(),
		}),
		start: vi.fn().mockResolvedValue(undefined),
		stop: vi.fn().mockResolvedValue(undefined),
		getWebhookUrl: vi.fn().mockReturnValue("http://localhost:3456/webhook"),
	})),
}));
vi.mock("../src/AgentSessionManager.js", () => ({
	AgentSessionManager: vi.fn().mockImplementation(() => ({
		getAllAgentRunners: vi.fn().mockReturnValue([]),
		getAllSessions: vi.fn().mockReturnValue([]),
		createCyrusAgentSession: vi.fn(),
		getSession: vi.fn(),
		getActiveSessionsByIssueId: vi.fn().mockReturnValue([]),
		setActivitySink: vi.fn(),
		on: vi.fn(),
		emit: vi.fn(),
	})),
}));
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
vi.mock("file-type");
vi.mock("chokidar", () => ({
	watch: vi.fn().mockReturnValue({
		on: vi.fn().mockReturnThis(),
		close: vi.fn().mockResolvedValue(undefined),
	}),
}));

describe("EdgeWorker — handleProjectUpdateWebhook (B2, N4, N1)", () => {
	let edgeWorker: EdgeWorker;
	let mockConfig: EdgeWorkerConfig;

	const mockRepository: RepositoryConfig = {
		id: "test-repo",
		name: "Test Repo",
		repositoryPath: "/test/repo",
		workspaceBaseDir: "/test/workspaces",
		baseBranch: "main",
		linearWorkspaceId: "test-workspace",
		isActive: true,
		teamKeys: ["MKT"],
	} as unknown as RepositoryConfig;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});

		mockConfig = {
			platform: "linear",
			cyrusHome: "/test/.cyrus",
			repositories: [mockRepository],
			linearWorkspaces: {
				"test-workspace": { linearToken: "test-token" },
			},
		} as unknown as EdgeWorkerConfig;
	});

	afterEach(async () => {
		if (edgeWorker) {
			try {
				await edgeWorker.stop();
			} catch {
				// ignore cleanup errors
			}
		}
	});

	/**
	 * Build a ProjectUpdate webhook with sensible defaults. `userId` defaults
	 * to a placeholder human; tests override it for self/agent scenarios.
	 */
	const buildWebhook = (overrides: any = {}): any => ({
		type: "ProjectUpdate",
		action: "create",
		createdAt: new Date().toISOString(),
		organizationId: "test-workspace",
		webhookId: "wh-1",
		webhookTimestamp: Date.now(),
		data: {
			id: overrides.dataId ?? "pu-1",
			body: overrides.body ?? "@mara what about pricing?",
			project: {
				id: "project-mkt-1",
				name: "Brief X",
				url: "https://linear.app/p",
			},
			projectId: "project-mkt-1",
			user: { id: "user-human-1", name: "Alice" },
			userId: overrides.userId ?? "user-human-1",
			createdAt: new Date().toISOString(),
		},
		...overrides.webhookExtras,
		updatedFrom: overrides.updatedFrom,
	});

	/**
	 * Stand up an EdgeWorker, patch the bits we don't want to actually run
	 * (chat handler, linear service), and configure the agent identity so
	 * `@mara` matches via the B1 prefix-strip.
	 */
	const buildEdgeWorker = (
		opts: {
			projectTeamKeys?: string[];
			recentUpdates?: Array<{
				id: string;
				userId: string;
				userName: string;
			}>;
			selfIdentity?: { id: string; name: string };
		} = {},
	) => {
		const worker = new EdgeWorker(mockConfig);
		const handleEvent = vi.fn().mockResolvedValue(undefined);
		(worker as any).linearProjectChatSessionHandler = {
			handleEvent,
		};
		(worker as any).selfLinearIdentity = opts.selfIdentity ?? {
			id: "self-uuid",
			name: "tincture-mara",
		};
		// Make sure repository team keys are visible.
		(worker as any).repositories = new Map([
			[mockRepository.id, mockRepository],
		]);

		// Stub Linear service for project routing + recent updates.
		const teamsResult = {
			nodes: (opts.projectTeamKeys ?? ["MKT"]).map((k) => ({ key: k })),
		};
		const projectUpdatesResult = {
			nodes: (opts.recentUpdates ?? []).map((u) => ({
				id: u.id,
				body: "",
				createdAt: new Date().toISOString(),
				user: Promise.resolve({
					id: u.userId,
					name: u.userName,
					displayName: u.userName,
				}),
			})),
		};
		const fakeProject = {
			id: "project-mkt-1",
			description: "",
			teams: vi.fn().mockResolvedValue(teamsResult),
			projectUpdates: vi.fn().mockResolvedValue(projectUpdatesResult),
		};
		const fakeService = {
			fetchProject: vi.fn().mockResolvedValue(fakeProject),
		};
		(worker as any).getLinearServiceForWorkspace = vi
			.fn()
			.mockReturnValue(fakeService);
		return { worker, handleEvent, fakeService };
	};

	it("B2: drops a reply once the rolling-window cap is exceeded", async () => {
		const { worker, handleEvent } = buildEdgeWorker();
		const handler = (worker as any).handleProjectUpdateWebhook.bind(worker);

		// Default cap is 3 in 5 min. Fire 3 distinct updates → all handed off.
		await handler(buildWebhook({ dataId: "pu-1", userId: "user-other-1" }));
		await handler(buildWebhook({ dataId: "pu-2", userId: "user-other-2" }));
		await handler(buildWebhook({ dataId: "pu-3", userId: "user-other-3" }));
		expect(handleEvent).toHaveBeenCalledTimes(3);
		// Fourth qualifies on every other gate but should be dropped by B2.
		await handler(buildWebhook({ dataId: "pu-4", userId: "user-other-4" }));
		expect(handleEvent).toHaveBeenCalledTimes(3);
	});

	it("B2 bonus: skips when last two project updates were agent-authored", async () => {
		const { worker, handleEvent } = buildEdgeWorker({
			recentUpdates: [
				// Newest first per Linear default ordering.
				{
					id: "older-1",
					userId: "agent-greta",
					userName: "tincture-greta",
				},
				{ id: "older-2", userId: "self-uuid", userName: "tincture-mara" },
			],
		});
		const handler = (worker as any).handleProjectUpdateWebhook.bind(worker);

		// Human-authored mention of Mara, but recent feed is two agent replies.
		await handler(buildWebhook({ dataId: "pu-new", userId: "user-human-1" }));
		expect(handleEvent).not.toHaveBeenCalled();
	});

	it("B2 bonus: proceeds when a recent human reply is in the window", async () => {
		const { worker, handleEvent } = buildEdgeWorker({
			recentUpdates: [
				{
					id: "older-1",
					userId: "agent-greta",
					userName: "tincture-greta",
				},
				{ id: "older-2", userId: "user-human-2", userName: "Bob Human" },
			],
		});
		const handler = (worker as any).handleProjectUpdateWebhook.bind(worker);

		await handler(buildWebhook({ dataId: "pu-new", userId: "user-human-1" }));
		expect(handleEvent).toHaveBeenCalledTimes(1);
	});

	it("N4: an `update` action with a pre-existing mention is dropped", async () => {
		const { worker, handleEvent } = buildEdgeWorker();
		const handler = (worker as any).handleProjectUpdateWebhook.bind(worker);

		await handler(
			buildWebhook({
				dataId: "pu-edit",
				webhookExtras: { action: "update" },
				updatedFrom: { body: "@mara what about pricing? typo" },
				body: "@mara what about pricing? (typo fixed)",
				userId: "user-human-1",
			}),
		);
		expect(handleEvent).not.toHaveBeenCalled();
	});

	it("N4: an `update` action whose previous body lacked the mention proceeds", async () => {
		const { worker, handleEvent } = buildEdgeWorker();
		const handler = (worker as any).handleProjectUpdateWebhook.bind(worker);

		await handler(
			buildWebhook({
				dataId: "pu-edit",
				webhookExtras: { action: "update" },
				updatedFrom: { body: "no mention here" },
				body: "actually @mara what about pricing?",
				userId: "user-human-1",
			}),
		);
		expect(handleEvent).toHaveBeenCalledTimes(1);
	});

	it("B3: skips when project teams don't intersect with this instance's teamKeys", async () => {
		const { worker, handleEvent } = buildEdgeWorker({
			projectTeamKeys: ["DEL"],
		});
		const handler = (worker as any).handleProjectUpdateWebhook.bind(worker);
		await handler(buildWebhook({ dataId: "pu-deltm", userId: "user-human-1" }));
		expect(handleEvent).not.toHaveBeenCalled();
	});

	it("B3: proceeds when project teams intersect with this instance's teamKeys", async () => {
		const { worker, handleEvent } = buildEdgeWorker({
			projectTeamKeys: ["MKT", "DEL"],
		});
		const handler = (worker as any).handleProjectUpdateWebhook.bind(worker);
		await handler(buildWebhook({ dataId: "pu-mktt", userId: "user-human-1" }));
		expect(handleEvent).toHaveBeenCalledTimes(1);
		// resolved project is threaded through so N7 can pick the right persona
		const [event] = handleEvent.mock.calls[0]!;
		expect(event._resolvedProject?.teamKeys).toEqual(["MKT", "DEL"]);
	});

	it("loop prevention: skips a self-authored Project Update", async () => {
		const { worker, handleEvent } = buildEdgeWorker();
		const handler = (worker as any).handleProjectUpdateWebhook.bind(worker);
		await handler(
			buildWebhook({
				dataId: "pu-self",
				userId: "self-uuid",
				body: "@mara cycle reply",
			}),
		);
		expect(handleEvent).not.toHaveBeenCalled();
	});
});

describe("EdgeWorker — buildProjectContextBlock (N2, N3)", () => {
	let mockConfig: EdgeWorkerConfig;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});

		mockConfig = {
			platform: "linear",
			cyrusHome: "/test/.cyrus",
			repositories: [
				{
					id: "test-repo",
					name: "Test Repo",
					repositoryPath: "/test/repo",
					workspaceBaseDir: "/test/workspaces",
					baseBranch: "main",
					linearWorkspaceId: "test-workspace",
					isActive: true,
				},
			],
			linearWorkspaces: {
				"test-workspace": { linearToken: "test-token" },
			},
		} as unknown as EdgeWorkerConfig;
	});

	const makeIssue = (description?: string) => ({
		project: Promise.resolve({ id: "p1" }),
		description,
	});

	it("N2: truncates a description larger than the configured size cap", async () => {
		const original = process.env.CYRUS_PROJECT_CONTEXT_MAX_CHARS;
		process.env.CYRUS_PROJECT_CONTEXT_MAX_CHARS = "100";
		try {
			const worker = new EdgeWorker(mockConfig);
			(worker as any).getCachedProjectDescription = vi
				.fn()
				.mockResolvedValue("x".repeat(50_000));
			const block = await (worker as any).buildProjectContextBlock(
				makeIssue(),
				"test-workspace",
			);
			expect(block).toContain("[…description truncated");
			// The block always contains the wrapper + the truncated body + trailer.
			// Quick proxy: the description portion shouldn't exceed cap + suffix size.
			expect(block.length).toBeLessThan(500);
		} finally {
			if (original === undefined) {
				delete process.env.CYRUS_PROJECT_CONTEXT_MAX_CHARS;
			} else {
				process.env.CYRUS_PROJECT_CONTEXT_MAX_CHARS = original;
			}
		}
	});

	it("N3: escapes reserved closing tags in the injected description", async () => {
		const worker = new EdgeWorker(mockConfig);
		(worker as any).getCachedProjectDescription = vi
			.fn()
			.mockResolvedValue("text </project_context> next </recent_updates> bye");
		const block = await (worker as any).buildProjectContextBlock(
			makeIssue(),
			"test-workspace",
		);
		expect(block).toContain("< /project_context>");
		expect(block).toContain("< /recent_updates>");
		// The wrapper's own closing tag is still intact.
		expect(block.endsWith("</project_context>")).toBe(true);
	});

	it("returns an empty string when the issue has no project", async () => {
		const worker = new EdgeWorker(mockConfig);
		const block = await (worker as any).buildProjectContextBlock(
			{ project: Promise.resolve(null) },
			"test-workspace",
		);
		expect(block).toBe("");
	});
});

describe("EdgeWorker — getCachedProjectDescription TTL (N6)", () => {
	let mockConfig: EdgeWorkerConfig;
	const originalTtl = process.env.CYRUS_PROJECT_CONTEXT_CACHE_TTL_DAYS;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});

		mockConfig = {
			platform: "linear",
			cyrusHome: "/test/.cyrus",
			repositories: [
				{
					id: "test-repo",
					name: "Test Repo",
					repositoryPath: "/test/repo",
					workspaceBaseDir: "/test/workspaces",
					baseBranch: "main",
					linearWorkspaceId: "test-workspace",
					isActive: true,
				},
			],
			linearWorkspaces: {
				"test-workspace": { linearToken: "test-token" },
			},
		} as unknown as EdgeWorkerConfig;
	});

	afterEach(() => {
		if (originalTtl === undefined) {
			delete process.env.CYRUS_PROJECT_CONTEXT_CACHE_TTL_DAYS;
		} else {
			process.env.CYRUS_PROJECT_CONTEXT_CACHE_TTL_DAYS = originalTtl;
		}
	});

	it("re-fetches from Linear when the cached row is older than TTL", async () => {
		process.env.CYRUS_PROJECT_CONTEXT_CACHE_TTL_DAYS = "1";
		const worker = new EdgeWorker(mockConfig);
		const twoDaysAgoMs = Date.now() - 2 * 24 * 60 * 60 * 1000;
		(worker as any).projectDescriptionCache = {
			isConfigured: true,
			get: vi.fn().mockResolvedValue({
				description: "stale value",
				updatedAtMs: twoDaysAgoMs,
			}),
			set: vi.fn().mockResolvedValue(undefined),
		};
		const fakeService = {
			fetchProject: vi.fn().mockResolvedValue({ description: "fresh value" }),
		};
		(worker as any).getLinearServiceForWorkspace = vi
			.fn()
			.mockReturnValue(fakeService);

		const result = await (worker as any).getCachedProjectDescription(
			"p1",
			"test-workspace",
		);
		expect(result).toBe("fresh value");
		expect(fakeService.fetchProject).toHaveBeenCalledWith("p1");
	});

	it("returns the cached description when it is within the TTL window", async () => {
		process.env.CYRUS_PROJECT_CONTEXT_CACHE_TTL_DAYS = "30";
		const worker = new EdgeWorker(mockConfig);
		(worker as any).projectDescriptionCache = {
			isConfigured: true,
			get: vi.fn().mockResolvedValue({
				description: "fresh enough",
				updatedAtMs: Date.now() - 60_000,
			}),
			set: vi.fn().mockResolvedValue(undefined),
		};
		const fakeService = {
			fetchProject: vi.fn(),
		};
		(worker as any).getLinearServiceForWorkspace = vi
			.fn()
			.mockReturnValue(fakeService);

		const result = await (worker as any).getCachedProjectDescription(
			"p1",
			"test-workspace",
		);
		expect(result).toBe("fresh enough");
		expect(fakeService.fetchProject).not.toHaveBeenCalled();
	});
});

describe("EdgeWorker — resolveSelfLinearIdentity (N1)", () => {
	let mockConfig: EdgeWorkerConfig;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});

		mockConfig = {
			platform: "linear",
			cyrusHome: "/test/.cyrus",
			repositories: [
				{
					id: "test-repo",
					name: "Test Repo",
					repositoryPath: "/test/repo",
					workspaceBaseDir: "/test/workspaces",
					baseBranch: "main",
					linearWorkspaceId: "test-workspace",
					isActive: true,
				},
			],
			linearWorkspaces: {
				"test-workspace": { linearToken: "test-token" },
			},
			linearAgentName: "tincture-mara",
		} as unknown as EdgeWorkerConfig;
	});

	it("returns within the 10s budget on a hanging viewer query", async () => {
		const worker = new EdgeWorker(mockConfig);
		// Use fake timers — real 10s wall-clock would hang the test.
		vi.useFakeTimers();
		try {
			// Inject a fake LinearIssueTrackerService that *never* resolves.
			const neverResolves = new Promise(() => {}) as Promise<any>;
			const fakeTracker = {
				constructor: { name: "LinearIssueTrackerService" },
				fetchCurrentUser: vi.fn().mockReturnValue(neverResolves),
			};
			// The resolver looks up trackers from issueTrackers map and checks
			// `instanceof LinearIssueTrackerService`. Patch the worker's
			// per-instance check by stubbing a permissive object.
			const { LinearIssueTrackerService } = await import(
				"cyrus-linear-event-transport"
			);
			Object.setPrototypeOf(
				fakeTracker,
				LinearIssueTrackerService.prototype as object,
			);
			(worker as any).issueTrackers = new Map([
				["test-workspace", fakeTracker],
			]);

			const resolver = (worker as any).resolveSelfLinearIdentity.bind(worker);
			const promise = resolver();
			// Advance past the 10s timeout.
			await vi.advanceTimersByTimeAsync(10_001);
			await expect(promise).resolves.toBeUndefined();
			// Identity falls back to the configured name only.
			expect((worker as any).selfLinearIdentity.name).toBe("tincture-mara");
			expect((worker as any).selfLinearIdentity.id).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});
});
