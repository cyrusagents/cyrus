import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_CYRUS_HOME } from "./test-dirs.js";

// Mock dependencies BEFORE imports (mirrors EdgeWorker.multi-repo-tools.test.ts)
vi.mock("cyrus-claude-runner", () => ({
	ClaudeRunner: vi.fn(),
	getSafeTools: vi.fn(() => ["Read", "Skill"]),
	getReadOnlyTools: vi.fn(() => ["Read", "Skill"]),
	getAllTools: vi.fn(() => ["Read", "Skill"]),
}));
vi.mock("@linear/sdk");
vi.mock("cyrus-linear-event-transport");
vi.mock("../src/SharedApplicationServer.js");
vi.mock("../src/AgentSessionManager.js");

import { LinearClient } from "@linear/sdk";
import { LinearEventTransport } from "cyrus-linear-event-transport";
import { AgentSessionManager } from "../src/AgentSessionManager.js";
import { EdgeWorker } from "../src/EdgeWorker.js";
import { SharedApplicationServer } from "../src/SharedApplicationServer.js";
import type { EdgeWorkerConfig, RepositoryConfig } from "../src/types.js";

describe("EdgeWorker.resolveSkillRepoPaths", () => {
	let edgeWorker: EdgeWorker;
	let mockConfig: EdgeWorkerConfig;

	const repository: RepositoryConfig = {
		id: "repo-a",
		name: "Repo A",
		// The base clone working tree. Cyrus only ever `git fetch`es this and
		// cuts worktrees from origin/<base>, so it stays frozen at the commit it
		// had when the repo was registered — its `.claude/skills/` goes stale.
		repositoryPath: "/cyrus/repos/repo-a",
		workspaceBaseDir: "/cyrus/workspaces-a",
		baseBranch: "main",
		linearWorkspaceId: "test-workspace",
		isActive: true,
	};

	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});

		mockConfig = {
			proxyUrl: "http://localhost:3000",
			cyrusHome: TEST_CYRUS_HOME,
			repositories: [repository],
			linearWorkspaces: {
				"test-workspace": { linearToken: "test-token" },
			},
		};

		vi.mocked(SharedApplicationServer).mockImplementation(function () {
			return {
				start: vi.fn().mockResolvedValue(undefined),
				stop: vi.fn().mockResolvedValue(undefined),
				getFastifyInstance: vi.fn().mockReturnValue({ post: vi.fn() }),
				getWebhookUrl: vi.fn().mockReturnValue("http://localhost:3456/webhook"),
				setWebhookHandler: vi.fn(),
				setOAuthCallbackHandler: vi.fn(),
			};
		} as any);

		vi.mocked(AgentSessionManager).mockImplementation(function () {
			return {
				addSession: vi.fn(),
				getSession: vi.fn(),
				removeSession: vi.fn(),
				getAllSessions: vi.fn().mockReturnValue([]),
				clearAllSessions: vi.fn(),
				on: vi.fn(),
			};
		} as any);

		vi.mocked(LinearEventTransport).mockImplementation(function () {
			return { register: vi.fn(), on: vi.fn(), removeAllListeners: vi.fn() };
		} as any);

		vi.mocked(LinearClient).mockImplementation(function () {
			return {
				viewer: vi
					.fn()
					.mockResolvedValue({ id: "test-user", email: "test@example.com" }),
			};
		} as any);

		edgeWorker = new EdgeWorker(mockConfig);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	const resolve = (repo: RepositoryConfig, session?: unknown): string[] =>
		(edgeWorker as any).resolveSkillRepoPaths(repo, session);

	it("uses the session worktree path for a single-repo session, not the base clone", () => {
		// Single-repo session: workspace.path IS the worktree (the SDK cwd that
		// actually loads `.claude/skills/`), distinct from the frozen base clone.
		const session = {
			workspace: { path: "/cyrus/worktrees/DEV-1", isGitWorktree: true },
		};

		const paths = resolve(repository, session);

		expect(paths).toEqual(["/cyrus/worktrees/DEV-1"]);
		// Regression guard: must NOT read the stale base clone working tree.
		expect(paths).not.toContain(repository.repositoryPath);
	});

	it("uses every worktree sub-path for a multi-repo session", () => {
		const session = {
			workspace: {
				path: "/cyrus/worktrees/DEV-2",
				isGitWorktree: false,
				repoPaths: {
					"repo-a": "/cyrus/worktrees/DEV-2/repo-a",
					"repo-b": "/cyrus/worktrees/DEV-2/repo-b",
				},
			},
		};

		const paths = resolve(repository, session);

		expect(paths).toContain("/cyrus/worktrees/DEV-2/repo-a");
		expect(paths).toContain("/cyrus/worktrees/DEV-2/repo-b");
	});

	it("falls back to the repository path when no session workspace is available", () => {
		expect(resolve(repository, undefined)).toEqual([repository.repositoryPath]);
		expect(resolve(repository, { workspace: {} })).toEqual([
			repository.repositoryPath,
		]);
	});
});
