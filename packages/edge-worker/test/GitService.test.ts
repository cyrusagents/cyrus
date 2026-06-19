import { execSync, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitService } from "../src/GitService.js";

vi.mock("node:child_process", () => ({
	execSync: vi.fn(),
	spawn: vi.fn(),
}));

vi.mock("node:fs", () => ({
	existsSync: vi.fn(() => true),
	mkdirSync: vi.fn(),
	readFileSync: vi.fn(() => ""),
	readdirSync: vi.fn(() => []),
	rmSync: vi.fn(),
	statSync: vi.fn(),
}));

vi.mock("../src/WorktreeIncludeService.js", () => ({
	WorktreeIncludeService: vi.fn().mockImplementation(function () {
		return {
			copyIgnoredFiles: vi.fn().mockResolvedValue(undefined),
		};
	}),
}));

const mockExecSync = vi.mocked(execSync);
const mockSpawn = vi.mocked(spawn);
const mockExistsSync = vi.mocked(existsSync);
const mockMkdirSync = vi.mocked(mkdirSync);
const mockReaddirSync = vi.mocked(readdirSync);
const mockRmSync = vi.mocked(rmSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockStatSync = vi.mocked(statSync);

const mockSuccessfulSpawn = (stdout = "", stderr = "") => {
	mockSpawn.mockImplementation(() => {
		const child = new EventEmitter() as any;
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		child.kill = vi.fn();
		setImmediate(() => {
			if (stdout) child.stdout.emit("data", Buffer.from(stdout));
			if (stderr) child.stderr.emit("data", Buffer.from(stderr));
			child.emit("close", 0, null);
		});
		return child;
	});
};

const mockFailedSpawn = (opts: {
	code?: number | null;
	signal?: string | null;
	stdout?: string;
	stderr?: string;
}) => {
	mockSpawn.mockImplementation(() => {
		const child = new EventEmitter() as any;
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		child.kill = vi.fn();
		setImmediate(() => {
			if (opts.stdout) child.stdout.emit("data", Buffer.from(opts.stdout));
			if (opts.stderr) child.stderr.emit("data", Buffer.from(opts.stderr));
			child.emit("close", opts.code ?? 1, opts.signal ?? null);
		});
		return child;
	});
};

describe("GitService", () => {
	let gitService: GitService;
	const mockLogger: any = {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		withContext: vi.fn().mockReturnThis(),
	};

	beforeEach(() => {
		vi.clearAllMocks();
		delete process.env.CYRUS_WORKTREES_DIR;
		delete process.env.SECRET_TOKEN;
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		mockSuccessfulSpawn();
		gitService = new GitService({ cyrusHome: "/home/user/.cyrus" }, mockLogger);
	});

	afterEach(() => {
		delete process.env.CYRUS_WORKTREES_DIR;
		delete process.env.SECRET_TOKEN;
		vi.restoreAllMocks();
	});

	describe("constructor", () => {
		it("defaults to cyrusHome/worktrees when workspaceBaseDir is omitted", async () => {
			const fallbackGitService = new GitService(
				{ cyrusHome: "/tmp/custom-cyrus-home" },
				mockLogger,
			);

			mockExistsSync.mockImplementation(
				(path) => String(path) === "/tmp/custom-cyrus-home/worktrees/DEF-123",
			);

			await fallbackGitService.deleteWorktree("DEF-123");

			expect(mockLogger.info).toHaveBeenCalledWith(
				expect.stringContaining("/tmp/custom-cyrus-home/worktrees/DEF-123"),
			);
		});

		it("prefers CYRUS_WORKTREES_DIR over cyrusHome defaults", async () => {
			process.env.CYRUS_WORKTREES_DIR = "/tmp/env-worktrees";
			const fallbackGitService = new GitService(
				{ cyrusHome: "/tmp/custom-cyrus-home" },
				mockLogger,
			);

			mockExistsSync.mockImplementation(
				(path) => String(path) === "/tmp/env-worktrees/DEF-123",
			);

			await fallbackGitService.deleteWorktree("DEF-123");

			expect(mockLogger.info).toHaveBeenCalledWith(
				expect.stringContaining("/tmp/env-worktrees/DEF-123"),
			);
		});

		it("dynamically reflects CYRUS_WORKTREES_DIR changes at runtime", async () => {
			const dynamicGitService = new GitService(
				{ cyrusHome: "/tmp/cyrus" },
				mockLogger,
			);

			// First call uses default cyrusHome (no env var set)
			mockExistsSync.mockReturnValue(true);
			mockReaddirSync.mockReturnValue([]);
			await dynamicGitService.deleteWorktree("ISSUE-1");
			expect(mockLogger.info).toHaveBeenCalledWith(
				expect.stringContaining("/tmp/cyrus/worktrees/ISSUE-1"),
			);

			mockLogger.info.mockClear();

			// Update env var at runtime — same GitService instance picks it up
			process.env.CYRUS_WORKTREES_DIR = "/new/runtime/path";
			await dynamicGitService.deleteWorktree("ISSUE-2");
			expect(mockLogger.info).toHaveBeenCalledWith(
				expect.stringContaining("/new/runtime/path/ISSUE-2"),
			);
		});
	});

	describe("findWorktreeByBranch", () => {
		it("returns the worktree path when the branch is found", () => {
			mockExecSync.mockReturnValue(
				[
					"worktree /home/user/repo",
					"HEAD abc123def456",
					"branch refs/heads/main",
					"",
					"worktree /home/user/.cyrus/worktrees/ENG-97",
					"HEAD 789abc012def",
					"branch refs/heads/cyrustester/eng-97-fix-shader",
					"",
				].join("\n"),
			);

			const result = gitService.findWorktreeByBranch(
				"cyrustester/eng-97-fix-shader",
				"/home/user/repo",
			);

			expect(result).toBe("/home/user/.cyrus/worktrees/ENG-97");
		});

		it("returns null when the branch is not found", () => {
			mockExecSync.mockReturnValue(
				[
					"worktree /home/user/repo",
					"HEAD abc123def456",
					"branch refs/heads/main",
					"",
				].join("\n"),
			);

			const result = gitService.findWorktreeByBranch(
				"nonexistent-branch",
				"/home/user/repo",
			);

			expect(result).toBeNull();
		});

		it("handles empty output gracefully", () => {
			mockExecSync.mockReturnValue("");

			const result = gitService.findWorktreeByBranch(
				"some-branch",
				"/home/user/repo",
			);

			expect(result).toBeNull();
		});

		it("handles bare worktree entries (no branch line)", () => {
			mockExecSync.mockReturnValue(
				[
					"worktree /home/user/repo",
					"HEAD abc123def456",
					"bare",
					"",
					"worktree /home/user/.cyrus/worktrees/ENG-97",
					"HEAD 789abc012def",
					"branch refs/heads/my-feature",
					"",
				].join("\n"),
			);

			const result = gitService.findWorktreeByBranch(
				"my-feature",
				"/home/user/repo",
			);

			expect(result).toBe("/home/user/.cyrus/worktrees/ENG-97");
		});

		it("returns null when git command fails", () => {
			mockExecSync.mockImplementation(() => {
				throw new Error("not a git repository");
			});

			const result = gitService.findWorktreeByBranch(
				"some-branch",
				"/not/a/repo",
			);

			expect(result).toBeNull();
		});

		it("handles detached HEAD entries (no branch line)", () => {
			mockExecSync.mockReturnValue(
				[
					"worktree /home/user/detached",
					"HEAD abc123def456",
					"detached",
					"",
				].join("\n"),
			);

			const result = gitService.findWorktreeByBranch(
				"some-branch",
				"/home/user/repo",
			);

			expect(result).toBeNull();
		});
	});

	describe("getGitMetadataDirectoriesForWorkspace", () => {
		// Map each worktree cwd to the metadata dirs `git rev-parse` reports for it.
		const metadataByCwd: Record<string, { gitDir: string; commonDir: string }> =
			{
				"/ws/ENG-1/repo-a": {
					gitDir: "/repos/repo-a/.git/worktrees/ENG-1",
					commonDir: "/repos/repo-a/.git",
				},
				"/ws/ENG-1/repo-b": {
					gitDir: "/repos/repo-b/.git/worktrees/ENG-1",
					commonDir: "/repos/repo-b/.git",
				},
			};

		const installRevParseMock = () => {
			mockExecSync.mockImplementation((cmd: any, opts: any) => {
				const cmdStr = String(cmd);
				const cwd = String(opts?.cwd ?? "");
				const entry = metadataByCwd[cwd];
				if (!entry) {
					// Container dir / non-repo path: git rev-parse fails.
					throw new Error("not a git repository");
				}
				if (cmdStr.includes("--git-dir")) return `${entry.gitDir}\n`;
				if (cmdStr.includes("--git-common-dir")) return `${entry.commonDir}\n`;
				return "";
			});
		};

		it("collects metadata dirs from every sub-worktree in a multi-repo workspace", () => {
			installRevParseMock();

			const result = gitService.getGitMetadataDirectoriesForWorkspace({
				// Parent container is NOT a git repo (mkdirSync'd directory).
				path: "/ws/ENG-1",
				isGitWorktree: true,
				repoPaths: {
					"repo-a": "/ws/ENG-1/repo-a",
					"repo-b": "/ws/ENG-1/repo-b",
				},
			});

			expect(new Set(result)).toEqual(
				new Set([
					"/repos/repo-a/.git/worktrees/ENG-1",
					"/repos/repo-a/.git",
					"/repos/repo-b/.git/worktrees/ENG-1",
					"/repos/repo-b/.git",
				]),
			);
		});

		it("resolves from workspace.path for single-repo workspaces", () => {
			mockExecSync.mockImplementation((cmd: any, opts: any) => {
				const cmdStr = String(cmd);
				if (String(opts?.cwd) !== "/ws/ENG-2") {
					throw new Error("not a git repository");
				}
				if (cmdStr.includes("--git-dir"))
					return "/repos/repo-a/.git/worktrees/ENG-2\n";
				if (cmdStr.includes("--git-common-dir")) return "/repos/repo-a/.git\n";
				return "";
			});

			const result = gitService.getGitMetadataDirectoriesForWorkspace({
				path: "/ws/ENG-2",
				isGitWorktree: true,
			});

			expect(new Set(result)).toEqual(
				new Set(["/repos/repo-a/.git/worktrees/ENG-2", "/repos/repo-a/.git"]),
			);
		});
	});

	// Shared helpers for test data
	const makeIssue = (overrides: Partial<any> = {}): any => ({
		id: "issue-1",
		identifier: "ENG-97",
		title: "Fix the shader",
		description: null,
		url: "",
		branchName: "cyrustester/eng-97-fix-shader",
		assigneeId: null,
		stateId: null,
		teamId: null,
		labelIds: [],
		priority: 0,
		createdAt: new Date(),
		updatedAt: new Date(),
		archivedAt: null,
		state: Promise.resolve(undefined),
		assignee: Promise.resolve(undefined),
		team: Promise.resolve(undefined),
		parent: Promise.resolve(undefined),
		project: Promise.resolve(undefined),
		labels: () => Promise.resolve({ nodes: [] }),
		comments: () => Promise.resolve({ nodes: [] }),
		attachments: () => Promise.resolve({ nodes: [] }),
		children: () => Promise.resolve({ nodes: [] }),
		inverseRelations: () => Promise.resolve({ nodes: [] }),
		update: () =>
			Promise.resolve({ success: true, issue: undefined, lastSyncId: 0 }),
		...overrides,
	});

	const makeRepository = (overrides: Partial<any> = {}): any => ({
		id: "repo-1",
		name: "test-repo",
		repositoryPath: "/home/user/repo",
		workspaceBaseDir: "/home/user/.cyrus/worktrees",
		baseBranch: "main",
		...overrides,
	});

	describe("createGitWorktree - 1 repo (backward compat)", () => {
		it("reuses existing worktree when branch is already checked out at a different path", async () => {
			const issue = makeIssue();
			const repository = makeRepository();

			let callCount = 0;
			mockExecSync.mockImplementation((cmd: any) => {
				const cmdStr = String(cmd);
				if (cmdStr === "git rev-parse --git-dir") {
					return Buffer.from(".git\n");
				}
				if (cmdStr === "git worktree list --porcelain") {
					callCount++;
					if (callCount === 1) {
						// First call: path-based check — doesn't contain workspacePath
						return "";
					}
					// Second call: branch-based check via findWorktreeByBranch
					return [
						"worktree /home/user/.cyrus/worktrees/LINEAR-SESSION",
						"HEAD 789abc012def",
						"branch refs/heads/cyrustester/eng-97-fix-shader",
						"",
					].join("\n");
				}
				if (
					cmdStr.includes(
						'git rev-parse --verify "cyrustester/eng-97-fix-shader"',
					)
				) {
					// Branch exists
					return Buffer.from("abc123\n");
				}
				return Buffer.from("");
			});

			const result = await gitService.createGitWorktree(issue, [repository]);

			expect(result.path).toBe("/home/user/.cyrus/worktrees/LINEAR-SESSION");
			expect(result.isGitWorktree).toBe(true);
			expect(mockLogger.info).toHaveBeenCalledWith(
				expect.stringContaining("already checked out in worktree"),
			);
		});

		it("catches 'already used by worktree' error and reuses existing worktree", async () => {
			const issue = makeIssue();
			const repository = makeRepository();

			mockExecSync.mockImplementation((cmd: any) => {
				const cmdStr = String(cmd);
				if (cmdStr === "git rev-parse --git-dir") {
					return Buffer.from(".git\n");
				}
				if (cmdStr === "git worktree list --porcelain") {
					// Both the path check and branch check return nothing
					return "";
				}
				if (
					cmdStr.includes(
						'git rev-parse --verify "cyrustester/eng-97-fix-shader"',
					)
				) {
					// Branch exists
					return Buffer.from("abc123\n");
				}
				if (cmdStr.includes("git fetch origin")) {
					return Buffer.from("");
				}
				if (cmdStr.includes("git worktree add")) {
					throw new Error(
						"fatal: 'cyrustester/eng-97-fix-shader' is already used by worktree at '/home/user/.cyrus/worktrees/LINEAR-SESSION'",
					);
				}
				return Buffer.from("");
			});

			mockExistsSync.mockImplementation((path: any) => {
				if (String(path) === "/home/user/.cyrus/worktrees/LINEAR-SESSION") {
					return true;
				}
				return false;
			});

			const result = await gitService.createGitWorktree(issue, [repository]);

			expect(result.path).toBe("/home/user/.cyrus/worktrees/LINEAR-SESSION");
			expect(result.isGitWorktree).toBe(true);
			expect(mockLogger.info).toHaveBeenCalledWith(
				expect.stringContaining("Reusing existing worktree"),
			);
		});

		it("falls back to empty directory for unrecognized errors", async () => {
			const issue = makeIssue();
			const repository = makeRepository();

			mockExecSync.mockImplementation((cmd: any) => {
				const cmdStr = String(cmd);
				if (cmdStr === "git rev-parse --git-dir") {
					return Buffer.from(".git\n");
				}
				if (cmdStr === "git worktree list --porcelain") {
					return "";
				}
				if (
					cmdStr.includes(
						'git rev-parse --verify "cyrustester/eng-97-fix-shader"',
					)
				) {
					return Buffer.from("abc123\n");
				}
				if (cmdStr.includes("git fetch origin")) {
					return Buffer.from("");
				}
				if (cmdStr.includes("git worktree add")) {
					throw new Error("fatal: some completely different error");
				}
				return Buffer.from("");
			});

			const result = await gitService.createGitWorktree(issue, [repository]);

			expect(result.path).toBe("/home/user/.cyrus/worktrees/ENG-97");
			expect(result.isGitWorktree).toBe(false);
		});
	});

	describe("createGitWorktree - repo setup hook discovery", () => {
		const setupSuccessfulWorktreeCreate = () => {
			mockExecSync.mockImplementation((cmd: any) => {
				const cmdStr = String(cmd);
				if (cmdStr === "git rev-parse --git-dir") {
					return Buffer.from(".git\n");
				}
				if (cmdStr === "git worktree list --porcelain") {
					return "";
				}
				if (
					cmdStr.includes(
						'git rev-parse --verify "cyrustester/eng-97-fix-shader"',
					)
				) {
					throw new Error("branch not found");
				}
				if (cmdStr.includes("git fetch origin")) {
					return Buffer.from("");
				}
				if (cmdStr.includes("git ls-remote")) {
					return Buffer.from("abc123\trefs/heads/main\n");
				}
				if (cmdStr.includes("git worktree add")) {
					return Buffer.from("");
				}
				if (cmdStr.includes("cyrus-setup.sh")) {
					return Buffer.from("");
				}
				return Buffer.from("");
			});
		};

		it("runs setup from the worktree when the persistent checkout lacks cyrus-setup.sh", async () => {
			const issue = makeIssue();
			const repository = makeRepository();
			setupSuccessfulWorktreeCreate();
			mockExistsSync.mockImplementation((path: any) => {
				const p = String(path);
				if (p === "/home/user/repo/cyrus-setup.sh") return false;
				if (p === "/home/user/.cyrus/worktrees/ENG-97/cyrus-setup.sh")
					return true;
				return false;
			});
			mockStatSync.mockImplementation((path: any) => {
				if (
					String(path) === "/home/user/.cyrus/worktrees/ENG-97/cyrus-setup.sh"
				) {
					return { mode: 0o755, isFile: () => false } as any;
				}
				return { isFile: () => false } as any;
			});

			const result = await gitService.createGitWorktree(issue, [repository]);

			expect(result.isGitWorktree).toBe(true);
			expect(mockSpawn).toHaveBeenCalledWith(
				"bash",
				["/home/user/.cyrus/worktrees/ENG-97/cyrus-setup.sh"],
				expect.objectContaining({
					cwd: "/home/user/.cyrus/worktrees/ENG-97",
					env: expect.objectContaining({
						LINEAR_ISSUE_ID: "issue-1",
						LINEAR_ISSUE_IDENTIFIER: "ENG-97",
						LINEAR_ISSUE_TITLE: "Fix the shader",
					}),
					shell: false,
				}),
			);
			expect(
				mockSpawn.mock.calls.some(
					([command, args]) =>
						command === "bash" &&
						Array.isArray(args) &&
						args.includes("/home/user/repo/cyrus-setup.sh"),
				),
			).toBe(false);
		});

		it("runs the worktree setup version when the persistent checkout also has cyrus-setup.sh", async () => {
			const issue = makeIssue();
			const repository = makeRepository();
			setupSuccessfulWorktreeCreate();
			mockExistsSync.mockImplementation((path: any) => {
				const p = String(path);
				if (p === "/home/user/repo/cyrus-setup.sh") return true;
				if (p === "/home/user/.cyrus/worktrees/ENG-97/cyrus-setup.sh")
					return true;
				return false;
			});
			mockStatSync.mockImplementation((path: any) => {
				if (
					String(path) === "/home/user/.cyrus/worktrees/ENG-97/cyrus-setup.sh"
				) {
					return { mode: 0o755, isFile: () => false } as any;
				}
				throw new Error(`unexpected stat: ${String(path)}`);
			});

			await gitService.createGitWorktree(issue, [repository]);

			const setupCommands = mockSpawn.mock.calls
				.map(([command, args]) => ({ command, args }))
				.filter(
					({ args }) =>
						Array.isArray(args) &&
						args.some((arg) => String(arg).includes("cyrus-setup.sh")),
				);
			expect(setupCommands).toEqual([
				{
					command: "bash",
					args: ["/home/user/.cyrus/worktrees/ENG-97/cyrus-setup.sh"],
				},
			]);
		});

		it("skips repo setup without failing worktree creation when the worktree lacks cyrus-setup.sh", async () => {
			const issue = makeIssue();
			const repository = makeRepository();
			setupSuccessfulWorktreeCreate();
			mockExistsSync.mockImplementation((path: any) => {
				const p = String(path);
				if (p === "/home/user/repo/cyrus-setup.sh") return true;
				if (p === "/home/user/.cyrus/worktrees/ENG-97/cyrus-setup.sh")
					return false;
				return false;
			});

			const result = await gitService.createGitWorktree(issue, [repository]);

			expect(result.path).toBe("/home/user/.cyrus/worktrees/ENG-97");
			expect(result.isGitWorktree).toBe(true);
			expect(
				mockSpawn.mock.calls.some(([command, args]) =>
					[command, ...(Array.isArray(args) ? args : [])].some((part) =>
						String(part).includes("cyrus-setup.sh"),
					),
				),
			).toBe(false);
		});

		it("emits repo setup start and success events with duration", async () => {
			const issue = makeIssue();
			const repository = makeRepository();
			const events: any[] = [];
			setupSuccessfulWorktreeCreate();
			mockExistsSync.mockImplementation(
				(path: any) =>
					String(path) === "/home/user/.cyrus/worktrees/ENG-97/cyrus-setup.sh",
			);
			mockStatSync.mockReturnValue({ mode: 0o755, isFile: () => false } as any);
			mockSuccessfulSpawn("ready\n");

			await gitService.createGitWorktree(issue, [repository], {
				onRepoSetupHookEvent: (event) => events.push(event),
			});

			expect(events).toHaveLength(2);
			expect(events[0]).toEqual({
				status: "started",
				issueIdentifier: "ENG-97",
				scriptName: "cyrus-setup.sh",
				repositoryName: "test-repo",
			});
			expect(events[1]).toMatchObject({
				status: "succeeded",
				issueIdentifier: "ENG-97",
				scriptName: "cyrus-setup.sh",
				repositoryName: "test-repo",
			});
			expect(events[1].durationMs).toEqual(expect.any(Number));
			expect(events[1].stdoutTail).toBeUndefined();
			expect(events[1].stderrTail).toBeUndefined();
		});

		it("emits repo setup failure events without failing worktree creation", async () => {
			const issue = makeIssue();
			const repository = makeRepository();
			const events: any[] = [];
			setupSuccessfulWorktreeCreate();
			mockExistsSync.mockImplementation(
				(path: any) =>
					String(path) === "/home/user/.cyrus/worktrees/ENG-97/cyrus-setup.sh",
			);
			mockStatSync.mockReturnValue({ mode: 0o755, isFile: () => false } as any);
			mockFailedSpawn({
				code: 42,
				stdout: "installing deps\n",
				stderr: "missing package\n",
			});

			const result = await gitService.createGitWorktree(issue, [repository], {
				onRepoSetupHookEvent: (event) => events.push(event),
			});

			expect(result.isGitWorktree).toBe(true);
			expect(events.map((event) => event.status)).toEqual([
				"started",
				"failed",
			]);
			expect(events[1]).toMatchObject({
				scriptName: "cyrus-setup.sh",
				exitCode: 42,
				errorMessage: "Script exited with code 42",
				stdoutTail: "installing deps",
				stderrTail: "missing package",
			});
		});

		it("truncates repo setup failure output tails", async () => {
			const issue = makeIssue();
			const repository = makeRepository();
			const events: any[] = [];
			setupSuccessfulWorktreeCreate();
			mockExistsSync.mockImplementation(
				(path: any) =>
					String(path) === "/home/user/.cyrus/worktrees/ENG-97/cyrus-setup.sh",
			);
			mockStatSync.mockReturnValue({ mode: 0o755, isFile: () => false } as any);
			const longStdout = Array.from(
				{ length: 45 },
				(_, index) => `stdout line ${index}`,
			).join("\n");
			mockFailedSpawn({ stdout: longStdout });

			await gitService.createGitWorktree(issue, [repository], {
				onRepoSetupHookEvent: (event) => events.push(event),
			});

			expect(events[1].stdoutTail).toContain("[output truncated");
			expect(events[1].stdoutTail).not.toContain("stdout line 0");
			expect(events[1].stdoutTail).toContain("stdout line 44");
			expect(events[1].truncated).toBe(true);
		});

		it("redacts secrets, environment values, and local paths from failure output", async () => {
			const issue = makeIssue();
			const repository = makeRepository();
			const events: any[] = [];
			process.env.SECRET_TOKEN = "super-secret-value";
			setupSuccessfulWorktreeCreate();
			mockExistsSync.mockImplementation(
				(path: any) =>
					String(path) === "/home/user/.cyrus/worktrees/ENG-97/cyrus-setup.sh",
			);
			mockStatSync.mockReturnValue({ mode: 0o755, isFile: () => false } as any);
			mockFailedSpawn({
				stdout:
					"SECRET_TOKEN=super-secret-value\npath=/home/user/.cyrus/worktrees/ENG-97/config\nalias=/private/home/user/.cyrus/worktrees/ENG-97/config\n",
				stderr: "Bearer abcdefghijklmnopqrstuvwxyz123456\n",
			});

			await gitService.createGitWorktree(issue, [repository], {
				onRepoSetupHookEvent: (event) => events.push(event),
			});

			const failed = events[1];
			const visibleOutput = `${failed.stdoutTail}\n${failed.stderrTail}`;
			expect(visibleOutput).not.toContain("super-secret-value");
			expect(visibleOutput).not.toContain("/home/user");
			expect(visibleOutput).not.toContain("/private");
			expect(visibleOutput).not.toContain(
				"Bearer abcdefghijklmnopqrstuvwxyz123456",
			);
			expect(visibleOutput).toContain("[REDACTED]");
			expect(visibleOutput).toContain("[workspace]");
		});
	});

	describe("createGitWorktree - stale worktree detection", () => {
		it("prunes and recreates worktree when git lists it but directory has no .git file", async () => {
			const issue = makeIssue();
			const repository = makeRepository();

			mockExecSync.mockImplementation((cmd: any) => {
				const cmdStr = String(cmd);
				if (cmdStr === "git rev-parse --git-dir") {
					return Buffer.from(".git\n");
				}
				if (cmdStr === "git worktree list --porcelain") {
					// Git still lists the stale worktree entry
					return `worktree /home/user/repo\nHEAD abc123\nbranch refs/heads/main\n\nworktree /home/user/.cyrus/worktrees/ENG-97\nHEAD def456\nbranch refs/heads/cyrustester/eng-97-fix-shader\n`;
				}
				if (cmdStr === "git worktree prune") {
					return Buffer.from("");
				}
				if (
					cmdStr.includes(
						'git rev-parse --verify "cyrustester/eng-97-fix-shader"',
					)
				) {
					throw new Error("not found");
				}
				if (cmdStr.includes("git fetch origin")) {
					return Buffer.from("");
				}
				if (cmdStr.includes("git ls-remote")) {
					return Buffer.from("abc123\trefs/heads/main\n");
				}
				if (cmdStr.includes("git worktree add")) {
					return Buffer.from("");
				}
				return Buffer.from("");
			});

			// The workspace path exists but does NOT have a valid .git file (stale)
			mockExistsSync.mockImplementation((path: any) => {
				const p = String(path);
				if (p === "/home/user/.cyrus/worktrees/ENG-97/.git") return false;
				return true;
			});

			const result = await gitService.createGitWorktree(issue, [repository]);

			expect(result.isGitWorktree).toBe(true);
			// Should have logged the stale worktree message
			expect(mockLogger.info).toHaveBeenCalledWith(
				expect.stringContaining("Stale worktree entry found"),
			);
			// Should have run git worktree prune
			expect(mockExecSync).toHaveBeenCalledWith("git worktree prune", {
				cwd: "/home/user/repo",
				stdio: "pipe",
			});
		});

		it("does not match substring paths in worktree list", async () => {
			const issue = makeIssue({ identifier: "CYSV-56" });
			const repository = makeRepository();

			mockExecSync.mockImplementation((cmd: any) => {
				const cmdStr = String(cmd);
				if (cmdStr === "git rev-parse --git-dir") {
					return Buffer.from(".git\n");
				}
				if (cmdStr === "git worktree list --porcelain") {
					// Only a sub-path worktree exists, not the exact path
					return `worktree /home/user/repo\nHEAD abc123\nbranch refs/heads/main\n\nworktree /home/user/.cyrus/worktrees/CYSV-56/cyrus\nHEAD def456\nbranch refs/heads/feat\n`;
				}
				if (
					cmdStr.includes(
						'git rev-parse --verify "cyrustester/eng-97-fix-shader"',
					)
				) {
					throw new Error("not found");
				}
				if (cmdStr.includes("git fetch origin")) {
					return Buffer.from("");
				}
				if (cmdStr.includes("git ls-remote")) {
					return Buffer.from("abc123\trefs/heads/main\n");
				}
				if (cmdStr.includes("git worktree add")) {
					return Buffer.from("");
				}
				return Buffer.from("");
			});

			const result = await gitService.createGitWorktree(issue, [repository]);

			expect(result.isGitWorktree).toBe(true);
			// Should NOT have logged "already exists" — the substring should not match
			expect(mockLogger.info).not.toHaveBeenCalledWith(
				expect.stringContaining("already exists"),
			);
		});
	});

	describe("deleteWorktree", () => {
		it("does nothing when workspace directory does not exist", async () => {
			mockExistsSync.mockReturnValue(false);

			await gitService.deleteWorktree("DEF-123");

			expect(mockRmSync).not.toHaveBeenCalled();
			expect(mockLogger.info).toHaveBeenCalledWith(
				expect.stringContaining("does not exist"),
			);
		});

		it("removes single-repo worktree and deletes directory", async () => {
			mockExistsSync.mockImplementation((path: any) => {
				const p = String(path);
				if (p === "/home/user/.cyrus/worktrees/DEF-123") return true;
				// .git file exists (it's a worktree)
				if (p === "/home/user/.cyrus/worktrees/DEF-123/.git") return true;
				// main repo exists
				if (p === "/home/user/repos/my-repo") return true;
				return false;
			});

			mockStatSync.mockImplementation((path: any) => {
				const p = String(path);
				if (p === "/home/user/.cyrus/worktrees/DEF-123/.git") {
					return { isFile: () => true } as any;
				}
				return { isFile: () => false } as any;
			});

			mockReadFileSync.mockImplementation((path: any) => {
				const p = String(path);
				if (p === "/home/user/.cyrus/worktrees/DEF-123/.git") {
					return "gitdir: /home/user/repos/my-repo/.git/worktrees/DEF-123";
				}
				return "";
			});

			mockExecSync.mockReturnValue(Buffer.from(""));

			await gitService.deleteWorktree("DEF-123");

			// Should run git worktree remove with cwd set to the main repo
			expect(mockExecSync).toHaveBeenCalledWith(
				'git worktree remove --force "/home/user/.cyrus/worktrees/DEF-123"',
				expect.objectContaining({
					stdio: "pipe",
					cwd: "/home/user/repos/my-repo",
				}),
			);

			// Should delete the directory
			expect(mockRmSync).toHaveBeenCalledWith(
				"/home/user/.cyrus/worktrees/DEF-123",
				{ recursive: true, force: true },
			);
		});

		it("removes multi-repo worktrees and deletes directory", async () => {
			mockExistsSync.mockImplementation((path: any) => {
				const p = String(path);
				if (p === "/home/user/.cyrus/worktrees/DEF-123") return true;
				// The root is NOT a worktree
				if (p === "/home/user/.cyrus/worktrees/DEF-123/.git") return false;
				// Subdirectory worktrees have .git files
				if (p === "/home/user/.cyrus/worktrees/DEF-123/repo-a/.git")
					return true;
				if (p === "/home/user/.cyrus/worktrees/DEF-123/repo-b/.git")
					return true;
				// main repos exist
				if (p === "/home/user/repos/repo-a") return true;
				if (p === "/home/user/repos/repo-b") return true;
				return false;
			});

			mockStatSync.mockImplementation((path: any) => {
				const p = String(path);
				if (
					p === "/home/user/.cyrus/worktrees/DEF-123/repo-a/.git" ||
					p === "/home/user/.cyrus/worktrees/DEF-123/repo-b/.git"
				) {
					return { isFile: () => true } as any;
				}
				return { isFile: () => false } as any;
			});

			mockReadFileSync.mockImplementation((path: any) => {
				const p = String(path);
				if (p === "/home/user/.cyrus/worktrees/DEF-123/repo-a/.git") {
					return "gitdir: /home/user/repos/repo-a/.git/worktrees/DEF-123";
				}
				if (p === "/home/user/.cyrus/worktrees/DEF-123/repo-b/.git") {
					return "gitdir: /home/user/repos/repo-b/.git/worktrees/DEF-123";
				}
				return "";
			});

			mockReaddirSync.mockReturnValue([
				{ name: "repo-a", isDirectory: () => true },
				{ name: "repo-b", isDirectory: () => true },
			] as any);

			mockExecSync.mockReturnValue(Buffer.from(""));

			await gitService.deleteWorktree("DEF-123");

			// Should run git worktree remove for both subdirectories with correct cwd
			expect(mockExecSync).toHaveBeenCalledWith(
				'git worktree remove --force "/home/user/.cyrus/worktrees/DEF-123/repo-a"',
				expect.objectContaining({
					stdio: "pipe",
					cwd: "/home/user/repos/repo-a",
				}),
			);
			expect(mockExecSync).toHaveBeenCalledWith(
				'git worktree remove --force "/home/user/.cyrus/worktrees/DEF-123/repo-b"',
				expect.objectContaining({
					stdio: "pipe",
					cwd: "/home/user/repos/repo-b",
				}),
			);

			// Should delete the directory
			expect(mockRmSync).toHaveBeenCalledWith(
				"/home/user/.cyrus/worktrees/DEF-123",
				{ recursive: true, force: true },
			);
		});

		it("handles git worktree remove failure gracefully", async () => {
			mockExistsSync.mockImplementation((path: any) => {
				const p = String(path);
				if (p === "/home/user/.cyrus/worktrees/DEF-123") return true;
				if (p === "/home/user/.cyrus/worktrees/DEF-123/.git") return true;
				if (p === "/home/user/repos/my-repo") return true;
				return false;
			});

			mockStatSync.mockImplementation((path: any) => {
				const p = String(path);
				if (p === "/home/user/.cyrus/worktrees/DEF-123/.git") {
					return { isFile: () => true } as any;
				}
				return { isFile: () => false } as any;
			});

			mockReadFileSync.mockImplementation((path: any) => {
				const p = String(path);
				if (p === "/home/user/.cyrus/worktrees/DEF-123/.git") {
					return "gitdir: /home/user/repos/my-repo/.git/worktrees/DEF-123";
				}
				return "";
			});

			mockExecSync.mockImplementation(() => {
				throw new Error("git worktree remove failed");
			});

			await gitService.deleteWorktree("DEF-123");

			// Should still attempt to delete the directory despite git failure
			expect(mockRmSync).toHaveBeenCalledWith(
				"/home/user/.cyrus/worktrees/DEF-123",
				{ recursive: true, force: true },
			);
			expect(mockLogger.warn).toHaveBeenCalledWith(
				expect.stringContaining("Failed to remove git worktree"),
			);
		});

		it("handles non-worktree directories (no .git file)", async () => {
			mockExistsSync.mockImplementation((path: any) => {
				const p = String(path);
				if (p === "/home/user/.cyrus/worktrees/DEF-123") return true;
				// No .git file anywhere
				return false;
			});

			mockReaddirSync.mockReturnValue([] as any);

			await gitService.deleteWorktree("DEF-123");

			// Should not call git worktree remove
			expect(mockExecSync).not.toHaveBeenCalled();

			// Should still delete the directory
			expect(mockRmSync).toHaveBeenCalledWith(
				"/home/user/.cyrus/worktrees/DEF-123",
				{ recursive: true, force: true },
			);
		});
	});

	describe("deleteWorktree - teardown wiring", () => {
		const makeRepo = (id: string, name: string, repoPath: string): any => ({
			id,
			name,
			repositoryPath: repoPath,
			workspaceBaseDir: "/home/user/.cyrus/worktrees",
		});

		const setupSingleRepoFs = () => {
			mockExistsSync.mockImplementation((path: any) => {
				const p = String(path);
				if (p === "/home/user/.cyrus/worktrees/DEF-123") return true;
				if (p === "/home/user/.cyrus/worktrees/DEF-123/.git") return true;
				if (p === "/home/user/repos/repo-a") return true;
				return false;
			});
			mockStatSync.mockImplementation((path: any) => {
				const p = String(path);
				if (p === "/home/user/.cyrus/worktrees/DEF-123/.git") {
					return { isFile: () => true } as any;
				}
				return { isFile: () => false } as any;
			});
			mockReadFileSync.mockImplementation((path: any) => {
				const p = String(path);
				if (p === "/home/user/.cyrus/worktrees/DEF-123/.git") {
					return "gitdir: /home/user/repos/repo-a/.git/worktrees/DEF-123";
				}
				return "";
			});
		};

		it("runs cyrus-teardown.sh before worktree removal when present", async () => {
			setupSingleRepoFs();
			// Add the teardown script to filesystem mock
			mockExistsSync.mockImplementation((path: any) => {
				const p = String(path);
				if (p === "/home/user/.cyrus/worktrees/DEF-123") return true;
				if (p === "/home/user/.cyrus/worktrees/DEF-123/.git") return true;
				if (p === "/home/user/repos/repo-a") return true;
				if (p === "/home/user/.cyrus/worktrees/DEF-123/cyrus-teardown.sh")
					return true;
				return false;
			});
			mockStatSync.mockImplementation((path: any) => {
				const p = String(path);
				if (p === "/home/user/.cyrus/worktrees/DEF-123/.git") {
					return { isFile: () => true } as any;
				}
				if (p === "/home/user/.cyrus/worktrees/DEF-123/cyrus-teardown.sh") {
					return { mode: 0o755, isFile: () => false } as any;
				}
				return { isFile: () => false } as any;
			});

			mockExecSync.mockReturnValue(Buffer.from(""));

			await gitService.deleteWorktree("DEF-123", {
				repositories: [makeRepo("a", "repo-a", "/home/user/repos/repo-a")],
			});

			// Should run teardown with cwd set to workspace root (single-repo)
			expect(mockSpawn).toHaveBeenCalledWith(
				"bash",
				["/home/user/.cyrus/worktrees/DEF-123/cyrus-teardown.sh"],
				expect.objectContaining({
					cwd: "/home/user/.cyrus/worktrees/DEF-123",
					env: expect.objectContaining({
						LINEAR_ISSUE_IDENTIFIER: "DEF-123",
					}),
					shell: false,
				}),
			);

			// Teardown must run before worktree removal (assert order)
			const teardownOrder = mockSpawn.mock.invocationCallOrder[0];
			const removeOrder = mockExecSync.mock.invocationCallOrder.find(
				(_, index) =>
					String(mockExecSync.mock.calls[index]?.[0]).includes(
						"worktree remove",
					),
			);
			expect(teardownOrder).toBeDefined();
			expect(removeOrder).toBeDefined();
			expect(removeOrder!).toBeGreaterThan(teardownOrder!);

			expect(mockRmSync).toHaveBeenCalled();
		});

		it("does not run teardown when cyrus-teardown.sh is absent, still deletes worktree", async () => {
			setupSingleRepoFs();
			mockExecSync.mockReturnValue(Buffer.from(""));

			await gitService.deleteWorktree("DEF-123", {
				repositories: [makeRepo("a", "repo-a", "/home/user/repos/repo-a")],
			});

			const calls = mockExecSync.mock.calls.map((c) => String(c[0]));
			expect(calls.some((c) => c.includes("cyrus-teardown"))).toBe(false);
			expect(mockRmSync).toHaveBeenCalled();
		});

		it("continues with worktree deletion when teardown fails", async () => {
			mockExistsSync.mockImplementation((path: any) => {
				const p = String(path);
				if (p === "/home/user/.cyrus/worktrees/DEF-123") return true;
				if (p === "/home/user/.cyrus/worktrees/DEF-123/.git") return true;
				if (p === "/home/user/repos/repo-a") return true;
				if (p === "/home/user/.cyrus/worktrees/DEF-123/cyrus-teardown.sh")
					return true;
				return false;
			});
			mockStatSync.mockImplementation((path: any) => {
				const p = String(path);
				if (p === "/home/user/.cyrus/worktrees/DEF-123/.git") {
					return { isFile: () => true } as any;
				}
				if (p === "/home/user/.cyrus/worktrees/DEF-123/cyrus-teardown.sh") {
					return { mode: 0o755, isFile: () => false } as any;
				}
				return { isFile: () => false } as any;
			});
			mockReadFileSync.mockImplementation((path: any) => {
				const p = String(path);
				if (p === "/home/user/.cyrus/worktrees/DEF-123/.git") {
					return "gitdir: /home/user/repos/repo-a/.git/worktrees/DEF-123";
				}
				return "";
			});

			mockExecSync.mockReturnValue(Buffer.from(""));
			mockFailedSpawn({ stderr: "script blew up\n" });

			await gitService.deleteWorktree("DEF-123", {
				repositories: [makeRepo("a", "repo-a", "/home/user/repos/repo-a")],
			});

			expect(mockLogger.error).toHaveBeenCalledWith(
				expect.stringContaining("teardown script failed"),
			);
			expect(mockRmSync).toHaveBeenCalled();
		});

		it("warns and skips when teardown script is not executable", async () => {
			mockExistsSync.mockImplementation((path: any) => {
				const p = String(path);
				if (p === "/home/user/.cyrus/worktrees/DEF-123") return true;
				if (p === "/home/user/.cyrus/worktrees/DEF-123/.git") return true;
				if (p === "/home/user/repos/repo-a") return true;
				if (p === "/home/user/.cyrus/worktrees/DEF-123/cyrus-teardown.sh")
					return true;
				return false;
			});
			mockStatSync.mockImplementation((path: any) => {
				const p = String(path);
				if (p === "/home/user/.cyrus/worktrees/DEF-123/.git") {
					return { isFile: () => true } as any;
				}
				if (p === "/home/user/.cyrus/worktrees/DEF-123/cyrus-teardown.sh") {
					return { mode: 0o644, isFile: () => false } as any;
				}
				return { isFile: () => false } as any;
			});
			mockReadFileSync.mockImplementation((path: any) => {
				const p = String(path);
				if (p === "/home/user/.cyrus/worktrees/DEF-123/.git") {
					return "gitdir: /home/user/repos/repo-a/.git/worktrees/DEF-123";
				}
				return "";
			});
			mockExecSync.mockReturnValue(Buffer.from(""));

			await gitService.deleteWorktree("DEF-123", {
				repositories: [makeRepo("a", "repo-a", "/home/user/repos/repo-a")],
			});

			const execCmds = mockExecSync.mock.calls.map((c) => String(c[0]));
			expect(execCmds.some((c) => c.includes("cyrus-teardown.sh"))).toBe(false);
			expect(mockLogger.warn).toHaveBeenCalledWith(
				expect.stringContaining("not executable"),
			);
		});

		it("does not attempt teardown when workspace dir is missing", async () => {
			mockExistsSync.mockReturnValue(false);

			await gitService.deleteWorktree("DEF-123", {
				repositories: [makeRepo("a", "repo-a", "/home/user/repos/repo-a")],
			});

			expect(mockExecSync).not.toHaveBeenCalled();
			expect(mockRmSync).not.toHaveBeenCalled();
		});

		it("multi-repo: runs both repos' teardowns with correct cwds", async () => {
			mockExistsSync.mockImplementation((path: any) => {
				const p = String(path);
				if (p === "/home/user/.cyrus/worktrees/DEF-123") return true;
				if (p === "/home/user/.cyrus/worktrees/DEF-123/.git") return false;
				if (p === "/home/user/.cyrus/worktrees/DEF-123/repo-a/.git")
					return true;
				if (p === "/home/user/.cyrus/worktrees/DEF-123/repo-b/.git")
					return true;
				if (p === "/home/user/repos/repo-a") return true;
				if (p === "/home/user/repos/repo-b") return true;
				if (
					p === "/home/user/.cyrus/worktrees/DEF-123/repo-a/cyrus-teardown.sh"
				)
					return true;
				if (
					p === "/home/user/.cyrus/worktrees/DEF-123/repo-b/cyrus-teardown.sh"
				)
					return true;
				return false;
			});
			mockStatSync.mockImplementation((path: any) => {
				const p = String(path);
				if (
					p === "/home/user/.cyrus/worktrees/DEF-123/repo-a/.git" ||
					p === "/home/user/.cyrus/worktrees/DEF-123/repo-b/.git"
				) {
					return { isFile: () => true } as any;
				}
				if (p.endsWith("cyrus-teardown.sh")) {
					return { mode: 0o755, isFile: () => false } as any;
				}
				return { isFile: () => false } as any;
			});
			mockReadFileSync.mockImplementation((path: any) => {
				const p = String(path);
				if (p === "/home/user/.cyrus/worktrees/DEF-123/repo-a/.git") {
					return "gitdir: /home/user/repos/repo-a/.git/worktrees/DEF-123";
				}
				if (p === "/home/user/.cyrus/worktrees/DEF-123/repo-b/.git") {
					return "gitdir: /home/user/repos/repo-b/.git/worktrees/DEF-123";
				}
				return "";
			});
			mockReaddirSync.mockReturnValue([
				{ name: "repo-a", isDirectory: () => true },
				{ name: "repo-b", isDirectory: () => true },
			] as any);
			mockExecSync.mockReturnValue(Buffer.from(""));

			await gitService.deleteWorktree("DEF-123", {
				repositories: [
					makeRepo("a", "repo-a", "/home/user/repos/repo-a"),
					makeRepo("b", "repo-b", "/home/user/repos/repo-b"),
				],
			});

			expect(mockSpawn).toHaveBeenCalledWith(
				"bash",
				["/home/user/.cyrus/worktrees/DEF-123/repo-a/cyrus-teardown.sh"],
				expect.objectContaining({
					cwd: "/home/user/.cyrus/worktrees/DEF-123/repo-a",
				}),
			);
			expect(mockSpawn).toHaveBeenCalledWith(
				"bash",
				["/home/user/.cyrus/worktrees/DEF-123/repo-b/cyrus-teardown.sh"],
				expect.objectContaining({
					cwd: "/home/user/.cyrus/worktrees/DEF-123/repo-b",
				}),
			);
		});

		it("multi-repo: only one repo has a teardown, the other is silently skipped", async () => {
			mockExistsSync.mockImplementation((path: any) => {
				const p = String(path);
				if (p === "/home/user/.cyrus/worktrees/DEF-123") return true;
				if (p === "/home/user/.cyrus/worktrees/DEF-123/.git") return false;
				if (p === "/home/user/.cyrus/worktrees/DEF-123/repo-a/.git")
					return true;
				if (p === "/home/user/.cyrus/worktrees/DEF-123/repo-b/.git")
					return true;
				if (p === "/home/user/repos/repo-a") return true;
				if (p === "/home/user/repos/repo-b") return true;
				// Only repo-a has a teardown script
				if (
					p === "/home/user/.cyrus/worktrees/DEF-123/repo-a/cyrus-teardown.sh"
				)
					return true;
				return false;
			});
			mockStatSync.mockImplementation((path: any) => {
				const p = String(path);
				if (
					p === "/home/user/.cyrus/worktrees/DEF-123/repo-a/.git" ||
					p === "/home/user/.cyrus/worktrees/DEF-123/repo-b/.git"
				) {
					return { isFile: () => true } as any;
				}
				if (
					p === "/home/user/.cyrus/worktrees/DEF-123/repo-a/cyrus-teardown.sh"
				) {
					return { mode: 0o755, isFile: () => false } as any;
				}
				return { isFile: () => false } as any;
			});
			mockReadFileSync.mockImplementation((path: any) => {
				const p = String(path);
				if (p === "/home/user/.cyrus/worktrees/DEF-123/repo-a/.git") {
					return "gitdir: /home/user/repos/repo-a/.git/worktrees/DEF-123";
				}
				if (p === "/home/user/.cyrus/worktrees/DEF-123/repo-b/.git") {
					return "gitdir: /home/user/repos/repo-b/.git/worktrees/DEF-123";
				}
				return "";
			});
			mockReaddirSync.mockReturnValue([
				{ name: "repo-a", isDirectory: () => true },
				{ name: "repo-b", isDirectory: () => true },
			] as any);
			mockExecSync.mockReturnValue(Buffer.from(""));

			await gitService.deleteWorktree("DEF-123", {
				repositories: [
					makeRepo("a", "repo-a", "/home/user/repos/repo-a"),
					makeRepo("b", "repo-b", "/home/user/repos/repo-b"),
				],
			});

			const teardownCalls = mockSpawn.mock.calls
				.flatMap(([command, args]) => [
					command,
					...(Array.isArray(args) ? args : []),
				])
				.map(String)
				.filter((c) => c.includes("cyrus-teardown.sh"));
			expect(teardownCalls).toHaveLength(1);
			expect(teardownCalls[0]).toContain(
				"/home/user/.cyrus/worktrees/DEF-123/repo-a/",
			);
		});

		it("multi-repo: one teardown failing does not skip the other or block rmSync", async () => {
			mockExistsSync.mockImplementation((path: any) => {
				const p = String(path);
				if (p === "/home/user/.cyrus/worktrees/DEF-123") return true;
				if (p === "/home/user/.cyrus/worktrees/DEF-123/.git") return false;
				if (p === "/home/user/.cyrus/worktrees/DEF-123/repo-a/.git")
					return true;
				if (p === "/home/user/.cyrus/worktrees/DEF-123/repo-b/.git")
					return true;
				if (p === "/home/user/repos/repo-a") return true;
				if (p === "/home/user/repos/repo-b") return true;
				if (
					p === "/home/user/.cyrus/worktrees/DEF-123/repo-a/cyrus-teardown.sh"
				)
					return true;
				if (
					p === "/home/user/.cyrus/worktrees/DEF-123/repo-b/cyrus-teardown.sh"
				)
					return true;
				return false;
			});
			mockStatSync.mockImplementation((path: any) => {
				const p = String(path);
				if (
					p === "/home/user/.cyrus/worktrees/DEF-123/repo-a/.git" ||
					p === "/home/user/.cyrus/worktrees/DEF-123/repo-b/.git"
				) {
					return { isFile: () => true } as any;
				}
				if (p.endsWith("cyrus-teardown.sh")) {
					return { mode: 0o755, isFile: () => false } as any;
				}
				return { isFile: () => false } as any;
			});
			mockReadFileSync.mockImplementation((path: any) => {
				const p = String(path);
				if (p === "/home/user/.cyrus/worktrees/DEF-123/repo-a/.git") {
					return "gitdir: /home/user/repos/repo-a/.git/worktrees/DEF-123";
				}
				if (p === "/home/user/.cyrus/worktrees/DEF-123/repo-b/.git") {
					return "gitdir: /home/user/repos/repo-b/.git/worktrees/DEF-123";
				}
				return "";
			});
			mockReaddirSync.mockReturnValue([
				{ name: "repo-a", isDirectory: () => true },
				{ name: "repo-b", isDirectory: () => true },
			] as any);

			mockExecSync.mockReturnValue(Buffer.from(""));
			let spawnCount = 0;
			mockSpawn.mockImplementation(() => {
				spawnCount++;
				const child = new EventEmitter() as any;
				child.stdout = new EventEmitter();
				child.stderr = new EventEmitter();
				child.kill = vi.fn();
				setImmediate(() => {
					child.emit("close", spawnCount === 1 ? 1 : 0, null);
				});
				return child;
			});

			await gitService.deleteWorktree("DEF-123", {
				repositories: [
					makeRepo("a", "repo-a", "/home/user/repos/repo-a"),
					makeRepo("b", "repo-b", "/home/user/repos/repo-b"),
				],
			});

			// repo-b's teardown was still attempted
			expect(mockSpawn).toHaveBeenCalledWith(
				"bash",
				["/home/user/.cyrus/worktrees/DEF-123/repo-b/cyrus-teardown.sh"],
				expect.anything(),
			);
			// rmSync still ran
			expect(mockRmSync).toHaveBeenCalledWith(
				"/home/user/.cyrus/worktrees/DEF-123",
				{ recursive: true, force: true },
			);
		});

		it("does not run teardown when repositories option is empty", async () => {
			setupSingleRepoFs();
			// Add a teardown that WOULD run if discovered — none should be picked up
			mockExistsSync.mockImplementation((path: any) => {
				const p = String(path);
				if (p === "/home/user/.cyrus/worktrees/DEF-123") return true;
				if (p === "/home/user/.cyrus/worktrees/DEF-123/.git") return true;
				if (p === "/home/user/repos/repo-a") return true;
				if (p === "/home/user/.cyrus/worktrees/DEF-123/cyrus-teardown.sh")
					return true;
				return false;
			});
			mockExecSync.mockReturnValue(Buffer.from(""));

			await gitService.deleteWorktree("DEF-123");

			const teardownCalls = mockExecSync.mock.calls
				.map((c) => String(c[0]))
				.filter((c) => c.includes("cyrus-teardown"));
			expect(teardownCalls).toHaveLength(0);
		});

		it("logs timeout message with '2 minutes' when teardown is SIGTERM'd", async () => {
			mockExistsSync.mockImplementation((path: any) => {
				const p = String(path);
				if (p === "/home/user/.cyrus/worktrees/DEF-123") return true;
				if (p === "/home/user/.cyrus/worktrees/DEF-123/.git") return true;
				if (p === "/home/user/repos/repo-a") return true;
				if (p === "/home/user/.cyrus/worktrees/DEF-123/cyrus-teardown.sh")
					return true;
				return false;
			});
			mockStatSync.mockImplementation((path: any) => {
				const p = String(path);
				if (p === "/home/user/.cyrus/worktrees/DEF-123/.git") {
					return { isFile: () => true } as any;
				}
				if (p === "/home/user/.cyrus/worktrees/DEF-123/cyrus-teardown.sh") {
					return { mode: 0o755, isFile: () => false } as any;
				}
				return { isFile: () => false } as any;
			});
			mockReadFileSync.mockImplementation((path: any) => {
				const p = String(path);
				if (p === "/home/user/.cyrus/worktrees/DEF-123/.git") {
					return "gitdir: /home/user/repos/repo-a/.git/worktrees/DEF-123";
				}
				return "";
			});
			mockExecSync.mockReturnValue(Buffer.from(""));
			mockFailedSpawn({ code: null, signal: "SIGTERM" });

			await gitService.deleteWorktree("DEF-123", {
				repositories: [makeRepo("a", "repo-a", "/home/user/repos/repo-a")],
			});

			expect(mockLogger.error).toHaveBeenCalledWith(
				expect.stringContaining("timed out (exceeded 2 minutes)"),
			);
		});
	});

	describe("createGitWorktree - 0 repos", () => {
		it("creates a plain folder with no git worktree", async () => {
			const issue = makeIssue();

			const result = await gitService.createGitWorktree(issue, [], {
				workspaceBaseDir: "/home/user/.cyrus/worktrees",
			});

			expect(result.path).toBe("/home/user/.cyrus/worktrees/ENG-97");
			expect(result.isGitWorktree).toBe(false);
			expect(result.repoPaths).toBeUndefined();
			expect(mockMkdirSync).toHaveBeenCalledWith(
				"/home/user/.cyrus/worktrees/ENG-97",
				{ recursive: true },
			);
		});

		it("throws if workspaceBaseDir is not provided with 0 repos", async () => {
			const issue = makeIssue();

			await expect(gitService.createGitWorktree(issue, [])).rejects.toThrow(
				"workspaceBaseDir is required",
			);
		});

		it("runs global setup script in the plain folder", async () => {
			const issue = makeIssue();

			// Mock existsSync to return true for the global script
			mockExistsSync.mockReturnValue(true);

			const result = await gitService.createGitWorktree(issue, [], {
				workspaceBaseDir: "/home/user/.cyrus/worktrees",
				globalSetupScript: "/home/user/setup.sh",
			});

			expect(result.path).toBe("/home/user/.cyrus/worktrees/ENG-97");
			expect(result.isGitWorktree).toBe(false);
		});
	});

	describe("createGitWorktree - N repos (multi-repo)", () => {
		it("creates parent folder with per-repo worktree subdirectories", async () => {
			const issue = makeIssue();
			const repo1 = makeRepository({
				id: "repo-1",
				name: "cyrus",
				repositoryPath: "/home/user/cyrus",
			});
			const repo2 = makeRepository({
				id: "repo-2",
				name: "cyrus-hosted",
				repositoryPath: "/home/user/cyrus-hosted",
			});

			// Mock git commands for both repos
			mockExecSync.mockImplementation((cmd: any) => {
				const cmdStr = String(cmd);
				if (cmdStr === "git rev-parse --git-dir") {
					return Buffer.from(".git\n");
				}
				if (cmdStr === "git worktree list --porcelain") {
					return "";
				}
				if (cmdStr.includes("git rev-parse --verify")) {
					// Branch doesn't exist (will create new)
					throw new Error("not found");
				}
				if (cmdStr.includes("git fetch origin")) {
					return Buffer.from("");
				}
				if (cmdStr.includes("git ls-remote")) {
					return Buffer.from("abc123 refs/heads/main\n");
				}
				if (cmdStr.includes("git worktree add")) {
					return Buffer.from("");
				}
				return Buffer.from("");
			});

			const result = await gitService.createGitWorktree(issue, [repo1, repo2]);

			expect(result.path).toBe("/home/user/.cyrus/worktrees/ENG-97");
			expect(result.isGitWorktree).toBe(true);
			expect(result.repoPaths).toBeDefined();
			expect(result.repoPaths!["repo-1"]).toBe(
				"/home/user/.cyrus/worktrees/ENG-97/cyrus",
			);
			expect(result.repoPaths!["repo-2"]).toBe(
				"/home/user/.cyrus/worktrees/ENG-97/cyrus-hosted",
			);
		});

		it("uses first repo workspaceBaseDir when no override", async () => {
			const issue = makeIssue();
			const repo1 = makeRepository({
				id: "repo-1",
				name: "cyrus",
				repositoryPath: "/home/user/cyrus",
				workspaceBaseDir: "/home/user/.cyrus/worktrees",
			});
			const repo2 = makeRepository({
				id: "repo-2",
				name: "cyrus-hosted",
				repositoryPath: "/home/user/cyrus-hosted",
				workspaceBaseDir: "/other/base",
			});

			mockExecSync.mockImplementation((cmd: any) => {
				const cmdStr = String(cmd);
				if (cmdStr === "git rev-parse --git-dir") {
					return Buffer.from(".git\n");
				}
				if (cmdStr === "git worktree list --porcelain") {
					return "";
				}
				if (cmdStr.includes("git rev-parse --verify")) {
					throw new Error("not found");
				}
				if (cmdStr.includes("git fetch origin")) {
					return Buffer.from("");
				}
				if (cmdStr.includes("git ls-remote")) {
					return Buffer.from("abc123 refs/heads/main\n");
				}
				if (cmdStr.includes("git worktree add")) {
					return Buffer.from("");
				}
				return Buffer.from("");
			});

			const result = await gitService.createGitWorktree(issue, [repo1, repo2]);

			// Parent path uses first repo's workspaceBaseDir
			expect(result.path).toBe("/home/user/.cyrus/worktrees/ENG-97");
		});

		it("falls back to plain directory for individual repo failures in N-repo mode", async () => {
			const issue = makeIssue();
			const repo1 = makeRepository({
				id: "repo-1",
				name: "cyrus",
				repositoryPath: "/home/user/cyrus",
			});
			const repo2 = makeRepository({
				id: "repo-2",
				name: "cyrus-hosted",
				repositoryPath: "/home/user/does-not-exist",
			});

			mockExecSync.mockImplementation((cmd: any, opts: any) => {
				const cmdStr = String(cmd);
				if (cmdStr === "git rev-parse --git-dir") {
					// Second repo is not a git repo
					if (opts?.cwd === "/home/user/does-not-exist") {
						throw new Error("Not a git directory");
					}
					return Buffer.from(".git\n");
				}
				if (cmdStr === "git worktree list --porcelain") {
					return "";
				}
				if (cmdStr.includes("git rev-parse --verify")) {
					throw new Error("not found");
				}
				if (cmdStr.includes("git fetch origin")) {
					return Buffer.from("");
				}
				if (cmdStr.includes("git ls-remote")) {
					return Buffer.from("abc123 refs/heads/main\n");
				}
				if (cmdStr.includes("git worktree add")) {
					return Buffer.from("");
				}
				return Buffer.from("");
			});

			const result = await gitService.createGitWorktree(issue, [repo1, repo2]);

			expect(result.repoPaths).toBeDefined();
			// First repo should have succeeded
			expect(result.repoPaths!["repo-1"]).toBe(
				"/home/user/.cyrus/worktrees/ENG-97/cyrus",
			);
			// Second repo falls back to plain directory
			expect(result.repoPaths!["repo-2"]).toBe(
				"/home/user/.cyrus/worktrees/ENG-97/cyrus-hosted",
			);
		});
	});

	describe("determineBaseBranch", () => {
		it("returns default base branch when no graphite label and no parent", async () => {
			const issue = makeIssue();
			const repository = makeRepository();

			const result = await gitService.determineBaseBranch(issue, repository);

			expect(result.branch).toBe("main");
			expect(result.source).toBe("default");
		});

		it("uses parent branch when parent exists", async () => {
			const issue = makeIssue({
				parent: Promise.resolve({
					identifier: "ENG-96",
					title: "Parent issue",
					branchName: "cyrustester/eng-96-parent-issue",
				}),
			});
			const repository = makeRepository();

			// Mock branchExists to return true for parent branch
			mockExecSync.mockImplementation((cmd: any) => {
				const cmdStr = String(cmd);
				if (
					cmdStr.includes(
						'git rev-parse --verify "cyrustester/eng-96-parent-issue"',
					)
				) {
					return Buffer.from("abc123\n");
				}
				throw new Error("not found");
			});

			const result = await gitService.determineBaseBranch(issue, repository);

			expect(result.branch).toBe("cyrustester/eng-96-parent-issue");
			expect(result.source).toBe("parent-issue");
			expect(result.detail).toContain("ENG-96");
		});

		it("uses blocking issue branch when graphite label is present (priority over parent)", async () => {
			const blockingIssue = {
				identifier: "ENG-95",
				title: "Blocking issue",
				branchName: "cyrustester/eng-95-blocking",
			};

			const issue = makeIssue({
				parent: Promise.resolve({
					identifier: "ENG-96",
					title: "Parent issue",
					branchName: "cyrustester/eng-96-parent",
				}),
				labels: () =>
					Promise.resolve({
						nodes: [{ name: "graphite" }],
					}),
				inverseRelations: () =>
					Promise.resolve({
						nodes: [
							{
								type: "blocks",
								issue: Promise.resolve(blockingIssue),
							},
						],
					}),
			});
			const repository = makeRepository();

			// Mock branchExists to return true for blocking branch
			mockExecSync.mockImplementation((cmd: any) => {
				const cmdStr = String(cmd);
				if (
					cmdStr.includes(
						'git rev-parse --verify "cyrustester/eng-95-blocking"',
					)
				) {
					return Buffer.from("abc123\n");
				}
				throw new Error("not found");
			});

			const result = await gitService.determineBaseBranch(issue, repository);

			expect(result.branch).toBe("cyrustester/eng-95-blocking");
			expect(result.source).toBe("graphite-blocked-by");
			expect(result.detail).toContain("ENG-95");
			expect(mockLogger.info).toHaveBeenCalledWith(
				expect.stringContaining("blocking issue branch"),
			);
		});

		it("falls back to parent when blocking branch does not exist", async () => {
			const blockingIssue = {
				identifier: "ENG-95",
				title: "Blocking issue",
				branchName: "cyrustester/eng-95-blocking",
			};

			const issue = makeIssue({
				parent: Promise.resolve({
					identifier: "ENG-96",
					title: "Parent issue",
					branchName: "cyrustester/eng-96-parent",
				}),
				labels: () =>
					Promise.resolve({
						nodes: [{ name: "graphite" }],
					}),
				inverseRelations: () =>
					Promise.resolve({
						nodes: [
							{
								type: "blocks",
								issue: Promise.resolve(blockingIssue),
							},
						],
					}),
			});
			const repository = makeRepository();

			// Mock branchExists: blocking branch doesn't exist, parent does
			mockExecSync.mockImplementation((cmd: any) => {
				const cmdStr = String(cmd);
				if (
					cmdStr.includes('git rev-parse --verify "cyrustester/eng-96-parent"')
				) {
					return Buffer.from("abc123\n");
				}
				throw new Error("not found");
			});

			const result = await gitService.determineBaseBranch(issue, repository);

			expect(result.branch).toBe("cyrustester/eng-96-parent");
			expect(result.source).toBe("parent-issue");
			expect(result.detail).toContain("ENG-96");
		});

		it("falls back to default when no graphite blockers and no parent", async () => {
			const issue = makeIssue({
				labels: () =>
					Promise.resolve({
						nodes: [{ name: "graphite" }],
					}),
				// graphite label present but no blocking issues
				inverseRelations: () => Promise.resolve({ nodes: [] }),
			});
			const repository = makeRepository();

			const result = await gitService.determineBaseBranch(issue, repository);

			expect(result.branch).toBe("main");
			expect(result.source).toBe("default");
		});

		it("uses custom graphite label config", async () => {
			const blockingIssue = {
				identifier: "ENG-95",
				title: "Blocking",
				branchName: "eng-95-branch",
			};

			const issue = makeIssue({
				labels: () =>
					Promise.resolve({
						nodes: [{ name: "custom-graphite" }],
					}),
				inverseRelations: () =>
					Promise.resolve({
						nodes: [
							{
								type: "blocks",
								issue: Promise.resolve(blockingIssue),
							},
						],
					}),
			});
			const repository = makeRepository({
				labelPrompts: {
					graphite: { labels: ["custom-graphite"] },
				},
			});

			mockExecSync.mockImplementation((cmd: any) => {
				const cmdStr = String(cmd);
				if (cmdStr.includes('git rev-parse --verify "eng-95-branch"')) {
					return Buffer.from("abc123\n");
				}
				throw new Error("not found");
			});

			const result = await gitService.determineBaseBranch(issue, repository);

			expect(result.branch).toBe("eng-95-branch");
			expect(result.source).toBe("graphite-blocked-by");
			expect(result.detail).toContain("ENG-95");
		});
	});

	describe("hasGraphiteLabel", () => {
		it("returns true when issue has graphite label", async () => {
			const issue = makeIssue({
				labels: () =>
					Promise.resolve({
						nodes: [{ name: "graphite" }],
					}),
			});
			const repository = makeRepository();

			const result = await gitService.hasGraphiteLabel(issue, repository);

			expect(result).toBe(true);
		});

		it("returns false when issue does not have graphite label", async () => {
			const issue = makeIssue({
				labels: () =>
					Promise.resolve({
						nodes: [{ name: "bug" }],
					}),
			});
			const repository = makeRepository();

			const result = await gitService.hasGraphiteLabel(issue, repository);

			expect(result).toBe(false);
		});
	});

	describe("fetchBlockingIssues", () => {
		it("returns blocking issues from inverse relations", async () => {
			const blockingIssue = {
				identifier: "ENG-95",
				title: "Blocker",
			};
			const issue = makeIssue({
				inverseRelations: () =>
					Promise.resolve({
						nodes: [
							{
								type: "blocks",
								issue: Promise.resolve(blockingIssue),
							},
							{
								type: "related",
								issue: Promise.resolve({ identifier: "ENG-94" }),
							},
						],
					}),
			});

			const result = await gitService.fetchBlockingIssues(issue);

			expect(result).toHaveLength(1);
			expect(result[0]!.identifier).toBe("ENG-95");
		});

		it("returns empty array when no inverse relations", async () => {
			const issue = makeIssue({
				inverseRelations: () => Promise.resolve({ nodes: [] }),
			});

			const result = await gitService.fetchBlockingIssues(issue);

			expect(result).toHaveLength(0);
		});

		it("returns empty array when inverse relations fails", async () => {
			const issue = makeIssue({
				inverseRelations: () => Promise.reject(new Error("network error")),
			});

			const result = await gitService.fetchBlockingIssues(issue);

			expect(result).toHaveLength(0);
		});
	});
});
