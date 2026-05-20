import { execSync } from "node:child_process";
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
	WorktreeIncludeService: vi.fn().mockImplementation(() => ({
		copyIgnoredFiles: vi.fn().mockResolvedValue(undefined),
	})),
}));

const mockExecSync = vi.mocked(execSync);
const mockExistsSync = vi.mocked(existsSync);
const mockMkdirSync = vi.mocked(mkdirSync);
const mockReaddirSync = vi.mocked(readdirSync);
const mockRmSync = vi.mocked(rmSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockStatSync = vi.mocked(statSync);

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
		gitService = new GitService({ cyrusHome: "/home/user/.cyrus" }, mockLogger);
	});

	afterEach(() => {
		delete process.env.CYRUS_WORKTREES_DIR;
	});

	describe("constructor", () => {
		it("defaults to cyrusHome/worktrees when workspaceBaseDir is omitted", () => {
			const fallbackGitService = new GitService(
				{ cyrusHome: "/tmp/custom-cyrus-home" },
				mockLogger,
			);

			mockExistsSync.mockImplementation(
				(path) => String(path) === "/tmp/custom-cyrus-home/worktrees/DEF-123",
			);

			fallbackGitService.deleteWorktree("DEF-123");

			expect(mockLogger.info).toHaveBeenCalledWith(
				expect.stringContaining("/tmp/custom-cyrus-home/worktrees/DEF-123"),
			);
		});

		it("prefers CYRUS_WORKTREES_DIR over cyrusHome defaults", () => {
			process.env.CYRUS_WORKTREES_DIR = "/tmp/env-worktrees";
			const fallbackGitService = new GitService(
				{ cyrusHome: "/tmp/custom-cyrus-home" },
				mockLogger,
			);

			mockExistsSync.mockImplementation(
				(path) => String(path) === "/tmp/env-worktrees/DEF-123",
			);

			fallbackGitService.deleteWorktree("DEF-123");

			expect(mockLogger.info).toHaveBeenCalledWith(
				expect.stringContaining("/tmp/env-worktrees/DEF-123"),
			);
		});

		it("dynamically reflects CYRUS_WORKTREES_DIR changes at runtime", () => {
			const dynamicGitService = new GitService(
				{ cyrusHome: "/tmp/cyrus" },
				mockLogger,
			);

			// First call uses default cyrusHome (no env var set)
			mockExistsSync.mockReturnValue(true);
			mockReaddirSync.mockReturnValue([]);
			dynamicGitService.deleteWorktree("ISSUE-1");
			expect(mockLogger.info).toHaveBeenCalledWith(
				expect.stringContaining("/tmp/cyrus/worktrees/ISSUE-1"),
			);

			mockLogger.info.mockClear();

			// Update env var at runtime — same GitService instance picks it up
			process.env.CYRUS_WORKTREES_DIR = "/new/runtime/path";
			dynamicGitService.deleteWorktree("ISSUE-2");
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
		it("does nothing when workspace directory does not exist", () => {
			mockExistsSync.mockReturnValue(false);

			gitService.deleteWorktree("DEF-123");

			expect(mockRmSync).not.toHaveBeenCalled();
			expect(mockLogger.info).toHaveBeenCalledWith(
				expect.stringContaining("does not exist"),
			);
		});

		it("removes single-repo worktree and deletes directory", () => {
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

			gitService.deleteWorktree("DEF-123");

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

		it("removes multi-repo worktrees and deletes directory", () => {
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

			gitService.deleteWorktree("DEF-123");

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

		it("handles git worktree remove failure gracefully", () => {
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

			gitService.deleteWorktree("DEF-123");

			// Should still attempt to delete the directory despite git failure
			expect(mockRmSync).toHaveBeenCalledWith(
				"/home/user/.cyrus/worktrees/DEF-123",
				{ recursive: true, force: true },
			);
			expect(mockLogger.warn).toHaveBeenCalledWith(
				expect.stringContaining("Failed to remove git worktree"),
			);
		});

		it("handles non-worktree directories (no .git file)", () => {
			mockExistsSync.mockImplementation((path: any) => {
				const p = String(path);
				if (p === "/home/user/.cyrus/worktrees/DEF-123") return true;
				// No .git file anywhere
				return false;
			});

			mockReaddirSync.mockReturnValue([] as any);

			gitService.deleteWorktree("DEF-123");

			// Should not call git worktree remove
			expect(mockExecSync).not.toHaveBeenCalled();

			// Should still delete the directory
			expect(mockRmSync).toHaveBeenCalledWith(
				"/home/user/.cyrus/worktrees/DEF-123",
				{ recursive: true, force: true },
			);
		});

		describe("global teardown script", () => {
			const WORKSPACE = "/home/user/.cyrus/worktrees/DEF-123";
			const SCRIPT = "/home/user/scripts/teardown.sh";

			const setupExecutableTeardownScript = () => {
				mockExistsSync.mockImplementation((path: any) => {
					const p = String(path);
					if (p === WORKSPACE) return true;
					if (p === SCRIPT) return true;
					return false;
				});
				mockStatSync.mockImplementation((path: any) => {
					const p = String(path);
					if (p === SCRIPT) {
						return { mode: 0o755, isFile: () => false } as any;
					}
					return { isFile: () => false } as any;
				});
				mockReaddirSync.mockReturnValue([] as any);
			};

			it("runs the teardown script before rmSync with LINEAR_ISSUE_IDENTIFIER in env", () => {
				setupExecutableTeardownScript();

				const callOrder: string[] = [];
				mockExecSync.mockImplementation((cmd: any, opts: any) => {
					if (String(cmd).includes("teardown.sh")) {
						callOrder.push("teardown");
						expect(opts.cwd).toBe(WORKSPACE);
						expect(opts.env.LINEAR_ISSUE_IDENTIFIER).toBe("DEF-123");
						expect(opts.env.LINEAR_ISSUE_ID).toBeUndefined();
						expect(opts.env.LINEAR_ISSUE_TITLE).toBeUndefined();
						expect(opts.timeout).toBe(2 * 60 * 1000);
					}
					return Buffer.from("");
				});
				mockRmSync.mockImplementation(() => {
					callOrder.push("rm");
				});

				gitService.deleteWorktree("DEF-123", {
					globalTeardownScript: SCRIPT,
				});

				expect(callOrder).toEqual(["teardown", "rm"]);
			});

			it("does not block deletion when teardown script fails", () => {
				setupExecutableTeardownScript();

				mockExecSync.mockImplementation((cmd: any) => {
					if (String(cmd).includes("teardown.sh")) {
						throw new Error("script failed");
					}
					return Buffer.from("");
				});

				gitService.deleteWorktree("DEF-123", {
					globalTeardownScript: SCRIPT,
				});

				expect(mockRmSync).toHaveBeenCalledWith(WORKSPACE, {
					recursive: true,
					force: true,
				});
				expect(mockLogger.error).toHaveBeenCalledWith(
					expect.stringContaining("global teardown script failed"),
				);
			});

			it("does not invoke execSync when no teardown script is configured", () => {
				mockExistsSync.mockImplementation(
					(path: any) => String(path) === WORKSPACE,
				);
				mockReaddirSync.mockReturnValue([] as any);

				gitService.deleteWorktree("DEF-123");

				expect(mockExecSync).not.toHaveBeenCalled();
				expect(mockRmSync).toHaveBeenCalledWith(WORKSPACE, {
					recursive: true,
					force: true,
				});
			});

			it("warns and skips when teardown script does not exist", () => {
				mockExistsSync.mockImplementation((path: any) => {
					const p = String(path);
					if (p === WORKSPACE) return true;
					// Script path does NOT exist
					return false;
				});
				mockReaddirSync.mockReturnValue([] as any);

				gitService.deleteWorktree("DEF-123", {
					globalTeardownScript: SCRIPT,
				});

				expect(mockExecSync).not.toHaveBeenCalled();
				expect(mockLogger.warn).toHaveBeenCalledWith(
					expect.stringContaining("global teardown script not found"),
				);
				expect(mockRmSync).toHaveBeenCalled();
			});

			it("warns and skips when teardown script is not executable", () => {
				const originalPlatform = process.platform;
				Object.defineProperty(process, "platform", { value: "linux" });
				try {
					mockExistsSync.mockImplementation((path: any) => {
						const p = String(path);
						if (p === WORKSPACE) return true;
						if (p === SCRIPT) return true;
						return false;
					});
					mockStatSync.mockImplementation((path: any) => {
						const p = String(path);
						if (p === SCRIPT) {
							// Mode 0o644 — no owner-execute bit
							return { mode: 0o644, isFile: () => false } as any;
						}
						return { isFile: () => false } as any;
					});
					mockReaddirSync.mockReturnValue([] as any);

					gitService.deleteWorktree("DEF-123", {
						globalTeardownScript: SCRIPT,
					});

					expect(mockExecSync).not.toHaveBeenCalled();
					expect(mockLogger.warn).toHaveBeenCalledWith(
						expect.stringContaining("global teardown script is not executable"),
					);
					expect(mockRmSync).toHaveBeenCalled();
				} finally {
					Object.defineProperty(process, "platform", {
						value: originalPlatform,
					});
				}
			});

			it("logs '(exceeded 2 minutes)' when teardown script times out (SIGTERM)", () => {
				setupExecutableTeardownScript();

				mockExecSync.mockImplementation((cmd: any) => {
					if (String(cmd).includes("teardown.sh")) {
						const err: any = new Error("timeout");
						err.signal = "SIGTERM";
						throw err;
					}
					return Buffer.from("");
				});

				gitService.deleteWorktree("DEF-123", {
					globalTeardownScript: SCRIPT,
				});

				expect(mockLogger.error).toHaveBeenCalledWith(
					expect.stringContaining("timed out (exceeded 2 minutes)"),
				);
				expect(mockRmSync).toHaveBeenCalled();
			});

			it("does not attempt teardown when the workspace directory is missing", () => {
				mockExistsSync.mockReturnValue(false);

				gitService.deleteWorktree("DEF-123", {
					globalTeardownScript: SCRIPT,
				});

				expect(mockExecSync).not.toHaveBeenCalled();
				expect(mockRmSync).not.toHaveBeenCalled();
			});
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
