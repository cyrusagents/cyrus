import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GitService } from "../src/GitService.js";

vi.mock("node:child_process", () => ({
	execSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
	existsSync: vi.fn(() => true),
	mkdirSync: vi.fn(),
	statSync: vi.fn(),
}));

const mockExecSync = vi.mocked(execSync);
const mockExistsSync = vi.mocked(existsSync);

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
		gitService = new GitService(mockLogger);
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

	describe("createGitWorktree - worktree reuse", () => {
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

			const result = await gitService.createGitWorktree(issue, repository);

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

			const result = await gitService.createGitWorktree(issue, repository);

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

			const result = await gitService.createGitWorktree(issue, repository);

			expect(result.path).toBe("/home/user/.cyrus/worktrees/ENG-97");
			expect(result.isGitWorktree).toBe(false);
		});
	});
});
