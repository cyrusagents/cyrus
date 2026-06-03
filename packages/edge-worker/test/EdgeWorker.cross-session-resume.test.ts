import { ClaudeRunner } from "cyrus-claude-runner";
import { LinearEventTransport } from "cyrus-linear-event-transport";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager.js";
import { EdgeWorker } from "../src/EdgeWorker.js";
import { SharedApplicationServer } from "../src/SharedApplicationServer.js";
import type { EdgeWorkerConfig, RepositoryConfig } from "../src/types.js";
import { TEST_CYRUS_HOME } from "./test-dirs.js";

vi.mock("fs/promises", () => ({
	readFile: vi.fn(),
	writeFile: vi.fn(),
	mkdir: vi.fn(),
	rename: vi.fn(),
}));
vi.mock("cyrus-claude-runner");
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
vi.mock("file-type");

/**
 * Unit tests for EdgeWorker.resolveCrossSessionResume — the glue that lets a
 * newly-created agent session resume a prior runner conversation on the same
 * issue. The durable-record persistence and the runner fallback are covered in
 * their own suites; here we exercise the resolution + opt-in gating.
 */
describe("EdgeWorker - cross-session resume resolution", () => {
	let edgeWorker: EdgeWorker;
	let mockASM: any;

	const ISSUE = "issue-1";
	const CURRENT = "new-session";

	const repository: RepositoryConfig = {
		id: "repo-1",
		name: "Repo",
		repositoryPath: "/repo",
		workspaceBaseDir: "/workspaces",
		baseBranch: "main",
		linearWorkspaceId: "ws-1",
		isActive: true,
	};

	beforeEach(() => {
		delete process.env.CYRUS_RESUME_ACROSS_SESSIONS;

		mockASM = {
			getSessionsByIssueId: vi.fn().mockReturnValue([]),
			getLastSessionForIssue: vi.fn().mockReturnValue(undefined),
			on: vi.fn(),
		};
		vi.mocked(AgentSessionManager).mockImplementation(function () {
			return mockASM;
		});
		vi.mocked(SharedApplicationServer).mockImplementation(function () {
			return {
				start: vi.fn().mockResolvedValue(undefined),
				stop: vi.fn().mockResolvedValue(undefined),
				getFastifyInstance: vi.fn().mockReturnValue({ post: vi.fn() }),
				getWebhookUrl: vi.fn().mockReturnValue("http://localhost/webhook"),
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
		vi.mocked(ClaudeRunner).mockImplementation(function () {
			return {};
		} as any);

		const config: EdgeWorkerConfig = {
			proxyUrl: "http://localhost:3000",
			cyrusHome: TEST_CYRUS_HOME,
			repositories: [repository],
			linearWorkspaces: { "ws-1": { linearToken: "t" } },
			handlers: {
				createWorkspace: vi.fn().mockResolvedValue({
					path: "/workspaces/issue-1",
					isGitWorktree: false,
				}),
			},
		} as any;

		edgeWorker = new EdgeWorker(config);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env.CYRUS_RESUME_ACROSS_SESSIONS;
	});

	const resolve = () =>
		(edgeWorker as any).resolveCrossSessionResume(ISSUE, CURRENT, repository);

	it("returns undefined when the feature is disabled (default)", () => {
		mockASM.getSessionsByIssueId.mockReturnValue([
			{ id: "old", claudeSessionId: "claude-old", updatedAt: 1 },
		]);
		expect(resolve()).toBeUndefined();
	});

	it("resumes the most recent live prior session when enabled via env", () => {
		process.env.CYRUS_RESUME_ACROSS_SESSIONS = "1";
		mockASM.getSessionsByIssueId.mockReturnValue([
			{ id: "old-a", claudeSessionId: "claude-a", updatedAt: 10 },
			{ id: "old-b", claudeSessionId: "claude-b", updatedAt: 99 },
			{ id: CURRENT, updatedAt: 100 }, // current session excluded
		]);
		expect(resolve()).toEqual({
			resumeSessionId: "claude-b",
			runner: "claude",
		});
	});

	it("falls back to the durable record when no live session remains", () => {
		process.env.CYRUS_RESUME_ACROSS_SESSIONS = "true";
		mockASM.getSessionsByIssueId.mockReturnValue([]);
		mockASM.getLastSessionForIssue.mockReturnValue({
			claudeSessionId: "claude-durable",
			updatedAt: 5,
		});
		expect(resolve()).toEqual({
			resumeSessionId: "claude-durable",
			runner: "claude",
		});
	});

	it("maps non-claude runner ids to the right runner", () => {
		process.env.CYRUS_RESUME_ACROSS_SESSIONS = "1";
		mockASM.getSessionsByIssueId.mockReturnValue([
			{ id: "old", geminiSessionId: "gem-1", updatedAt: 1 },
		]);
		expect(resolve()).toEqual({ resumeSessionId: "gem-1", runner: "gemini" });
	});

	it("can be enabled per-repository without the env var", () => {
		const r = { ...repository, resumeAcrossSessions: true };
		mockASM.getSessionsByIssueId.mockReturnValue([
			{ id: "old", claudeSessionId: "claude-x", updatedAt: 1 },
		]);
		expect(
			(edgeWorker as any).resolveCrossSessionResume(ISSUE, CURRENT, r),
		).toEqual({ resumeSessionId: "claude-x", runner: "claude" });
	});

	it("returns undefined when enabled but no prior session exists", () => {
		process.env.CYRUS_RESUME_ACROSS_SESSIONS = "1";
		expect(resolve()).toBeUndefined();
	});
});
