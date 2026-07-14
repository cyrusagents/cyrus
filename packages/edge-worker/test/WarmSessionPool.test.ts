import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type AccessPolicyPort,
	WarmSessionPool,
	type WarmSessionPoolDeps,
} from "../src/WarmSessionPool.js";

// Stub the Claude Agent SDK's startup() so warmup() never spawns a subprocess.
const startupMock = vi.fn(async () => ({ id: "warm-query" }) as any);
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
	startup: (...args: unknown[]) => startupMock(...args),
}));

const REPO = {
	id: "repo-1",
	name: "Repo One",
	repositoryPath: "/repo",
	linearWorkspaceId: "ws-1",
	// no allowedTools override → resolveIssueMcpConfigPath returns undefined
} as any;

function makeSession(overrides: Record<string, unknown> = {}) {
	return {
		id: "sess-1",
		claudeSessionId: "claude-1",
		workspace: { path: "/repo/worktrees/S-1" },
		updatedAt: 1,
		metadata: {},
		issueContext: { issueIdentifier: "S-1" },
		...overrides,
	} as any;
}

function makeDeps(overrides: Partial<WarmSessionPoolDeps> = {}): {
	deps: WarmSessionPoolDeps;
	accessPolicy: AccessPolicyPort;
} {
	const accessPolicy: AccessPolicyPort = {
		compute: vi.fn(() => ({
			homeDir: "/home/u",
			denyReadPaths: [],
			allowReadPaths: [],
			allowWritePaths: [],
			toolDisallow: [],
			toolAllowExtra: [],
		})),
		toClaudeToolPatterns: vi.fn(() => ({
			allowedTools: [],
			disallowedTools: ["Read(//home/u/.ssh/**)"],
		})),
	};

	const deps: WarmSessionPoolDeps = {
		agentSessionManager: { getAllSessions: vi.fn(() => []) } as any,
		accessPolicy,
		mcpConfigService: {
			buildMcpConfig: vi.fn(() => ({})),
			buildMergedMcpConfigPath: vi.fn(() => undefined),
		} as any,
		skillsPluginResolver: {
			resolve: vi.fn(async () => []),
			discoverSkillNames: vi.fn(async () => []),
		} as any,
		gitService: {
			getGitMetadataDirectoriesForWorkspace: vi.fn(() => []),
		} as any,
		logger: {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			withContext: vi.fn(),
		} as any,
		cyrusHome: "/home/u/.cyrus",
		getConfig: vi.fn(() => ({}) as any),
		getRepositoryForSession: vi.fn(() => REPO),
		buildAllowedTools: vi.fn(() => ["Read", "Edit"]),
		buildDisallowedTools: vi.fn(() => ["Bash(rm)"]),
		...overrides,
	};
	return { deps, accessPolicy };
}

describe("WarmSessionPool", () => {
	beforeEach(() => {
		startupMock.mockClear();
		delete process.env.CYRUS_ENABLE_WARM_SESSIONS;
	});
	afterEach(() => {
		delete process.env.CYRUS_ENABLE_WARM_SESSIONS;
	});

	describe("isEnabled", () => {
		it("is false when unset or an unrecognized value", () => {
			const { deps } = makeDeps();
			const pool = new WarmSessionPool(deps);
			expect(pool.isEnabled()).toBe(false);
			process.env.CYRUS_ENABLE_WARM_SESSIONS = "yes";
			expect(pool.isEnabled()).toBe(false);
			process.env.CYRUS_ENABLE_WARM_SESSIONS = "0";
			expect(pool.isEnabled()).toBe(false);
		});

		it("is true for 1 / true (case-insensitive)", () => {
			const { deps } = makeDeps();
			const pool = new WarmSessionPool(deps);
			process.env.CYRUS_ENABLE_WARM_SESSIONS = "1";
			expect(pool.isEnabled()).toBe(true);
			process.env.CYRUS_ENABLE_WARM_SESSIONS = "TRUE";
			expect(pool.isEnabled()).toBe(true);
		});
	});

	describe("warmup", () => {
		it("is a no-op when disabled", async () => {
			const { deps } = makeDeps({
				agentSessionManager: {
					getAllSessions: vi.fn(() => [makeSession()]),
				} as any,
			});
			const pool = new WarmSessionPool(deps);
			await pool.warmup(30);
			expect(startupMock).not.toHaveBeenCalled();
			expect(pool.size()).toBe(0);
		});

		it("warms only sessions with claudeSessionId + workspace.path, newest-first, capped at count", async () => {
			process.env.CYRUS_ENABLE_WARM_SESSIONS = "1";
			const sessions = [
				makeSession({ id: "old", updatedAt: 1 }),
				makeSession({ id: "newest", updatedAt: 3 }),
				makeSession({ id: "mid", updatedAt: 2 }),
				makeSession({ id: "no-claude", claudeSessionId: undefined }),
				makeSession({ id: "no-workspace", workspace: undefined }),
			];
			const { deps } = makeDeps({
				agentSessionManager: {
					getAllSessions: vi.fn(() => sessions),
				} as any,
			});
			const pool = new WarmSessionPool(deps);

			await pool.warmup(2);

			// Only the two newest valid candidates get warmed.
			expect(startupMock).toHaveBeenCalledTimes(2);
			expect(pool.size()).toBe(2);
			expect(pool.acquireWarm("newest")).toBeDefined();
			expect(pool.acquireWarm("mid")).toBeDefined();
			expect(pool.acquireWarm("old")).toBeUndefined();
			expect(pool.acquireWarm("no-claude")).toBeUndefined();
		});

		it("derives home-directory denials via AccessPolicy.compute + toClaudeToolPatterns (drift-close)", async () => {
			process.env.CYRUS_ENABLE_WARM_SESSIONS = "1";
			const session = makeSession();
			const { deps, accessPolicy } = makeDeps({
				agentSessionManager: {
					getAllSessions: vi.fn(() => [session]),
				} as any,
			});
			const pool = new WarmSessionPool(deps);

			await pool.warmup(30);

			expect(accessPolicy.compute).toHaveBeenCalledTimes(1);
			const computeArg = (accessPolicy.compute as any).mock.calls[0][0];
			expect(computeArg.cwd).toBe("/repo/worktrees/S-1");
			// buildDisallowedTools output flows through as toolDisallow.
			expect(computeArg.toolDisallow).toEqual(["Bash(rm)"]);
			// The repo path + workspace path are among the allowed read dirs.
			expect(computeArg.allowReadDirectories).toContain("/repo");
			expect(computeArg.allowReadDirectories).toContain("/repo/worktrees/S-1");
			expect(accessPolicy.toClaudeToolPatterns).toHaveBeenCalledTimes(1);

			// The disallowedTools from toClaudeToolPatterns were passed to startup().
			const startupOpts = startupMock.mock.calls[0][0] as any;
			expect(startupOpts.options.disallowedTools).toEqual([
				"Read(//home/u/.ssh/**)",
			]);
		});
	});

	describe("acquireWarm / release", () => {
		it("acquireWarm consumes the slot and returns undefined the second time", async () => {
			process.env.CYRUS_ENABLE_WARM_SESSIONS = "1";
			const { deps } = makeDeps({
				agentSessionManager: {
					getAllSessions: vi.fn(() => [makeSession()]),
				} as any,
			});
			const pool = new WarmSessionPool(deps);
			await pool.warmup(30);

			expect(pool.acquireWarm("sess-1")).toBeDefined();
			expect(pool.acquireWarm("sess-1")).toBeUndefined();
			expect(pool.size()).toBe(0);
		});

		it("acquireWarm returns undefined when disabled even if a slot exists", async () => {
			process.env.CYRUS_ENABLE_WARM_SESSIONS = "1";
			const { deps } = makeDeps({
				agentSessionManager: {
					getAllSessions: vi.fn(() => [makeSession()]),
				} as any,
			});
			const pool = new WarmSessionPool(deps);
			await pool.warmup(30);
			expect(pool.size()).toBe(1);

			// Disable, then acquire → gated to undefined (slot stays put).
			delete process.env.CYRUS_ENABLE_WARM_SESSIONS;
			expect(pool.acquireWarm("sess-1")).toBeUndefined();
			expect(pool.size()).toBe(1);
		});

		it("release drops a slot unconditionally", async () => {
			process.env.CYRUS_ENABLE_WARM_SESSIONS = "1";
			const { deps } = makeDeps({
				agentSessionManager: {
					getAllSessions: vi.fn(() => [makeSession()]),
				} as any,
			});
			const pool = new WarmSessionPool(deps);
			await pool.warmup(30);
			expect(pool.size()).toBe(1);

			pool.release("sess-1");
			expect(pool.size()).toBe(0);
			// Releasing an absent slot is a no-op.
			pool.release("sess-1");
			expect(pool.size()).toBe(0);
		});
	});
});
