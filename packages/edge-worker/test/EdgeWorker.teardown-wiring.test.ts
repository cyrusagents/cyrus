import {
	EdgeConfigSchema,
	type EdgeWorkerConfig,
	type RepositoryConfig,
} from "cyrus-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EdgeWorker } from "../src/EdgeWorker.js";

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
		getFastifyInstance: vi
			.fn()
			.mockReturnValue({ get: vi.fn(), post: vi.fn() }),
		start: vi.fn().mockResolvedValue(undefined),
		stop: vi.fn().mockResolvedValue(undefined),
		getWebhookUrl: vi.fn().mockReturnValue("http://localhost:3456/webhook"),
	})),
}));
vi.mock("../src/AgentSessionManager.js", () => ({
	AgentSessionManager: vi.fn().mockImplementation(() => ({
		getSessionsByIssueId: vi.fn().mockReturnValue([]),
		getAllAgentRunners: vi.fn().mockReturnValue([]),
		getAllSessions: vi.fn().mockReturnValue([]),
		createResponseActivity: vi.fn().mockResolvedValue(undefined),
		requestSessionStop: vi.fn(),
		removeSession: vi.fn(),
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

describe("EdgeWorker — global_teardown_script wiring", () => {
	const mockRepository: RepositoryConfig = {
		id: "test-repo",
		name: "Test Repo",
		repositoryPath: "/test/repo",
		workspaceBaseDir: "/test/workspaces",
		baseBranch: "main",
		linearWorkspaceId: "test-workspace",
		isActive: true,
	};

	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	it("passes global_teardown_script through to gitService.deleteWorktree on terminal-state message", async () => {
		const config: EdgeWorkerConfig = {
			platform: "linear",
			cyrusHome: "/test/.cyrus",
			repositories: [mockRepository],
			linearWorkspaces: {
				"test-workspace": { linearToken: "test-token" },
			},
			global_teardown_script: "/path/to/teardown.sh",
		} as any;

		const edgeWorker = new EdgeWorker(config);
		const deleteWorktreeSpy = vi
			.spyOn((edgeWorker as any).gitService, "deleteWorktree")
			.mockImplementation(() => undefined);

		await (edgeWorker as any).handleIssueStateChangeMessage({
			workItemId: "issue-123",
			workItemIdentifier: "DEF-123",
		});

		expect(deleteWorktreeSpy).toHaveBeenCalledWith("DEF-123", {
			globalTeardownScript: "/path/to/teardown.sh",
		});
	});

	it("passes undefined when global_teardown_script is not configured", async () => {
		const config: EdgeWorkerConfig = {
			platform: "linear",
			cyrusHome: "/test/.cyrus",
			repositories: [mockRepository],
			linearWorkspaces: {
				"test-workspace": { linearToken: "test-token" },
			},
		} as any;

		const edgeWorker = new EdgeWorker(config);
		const deleteWorktreeSpy = vi
			.spyOn((edgeWorker as any).gitService, "deleteWorktree")
			.mockImplementation(() => undefined);

		await (edgeWorker as any).handleIssueStateChangeMessage({
			workItemId: "issue-456",
			workItemIdentifier: "DEF-456",
		});

		expect(deleteWorktreeSpy).toHaveBeenCalledWith("DEF-456", {
			globalTeardownScript: undefined,
		});
	});
});

describe("EdgeConfigSchema — global_teardown_script", () => {
	it("accepts global_teardown_script as an optional string", () => {
		const result = EdgeConfigSchema.safeParse({
			repositories: [],
			global_teardown_script: "/path/to/teardown.sh",
		});
		expect(result.success).toBe(true);
	});

	it("treats global_teardown_script as optional", () => {
		const result = EdgeConfigSchema.safeParse({ repositories: [] });
		expect(result.success).toBe(true);
	});
});
