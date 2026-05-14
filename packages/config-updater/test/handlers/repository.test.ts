import { exec } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	handleRepository,
	handleRepositoryDelete,
} from "../../src/handlers/repository.js";
import type {
	DeleteRepositoryPayload,
	RepositoryPayload,
} from "../../src/types.js";

// Mock node:child_process
vi.mock("node:child_process", () => ({
	exec: vi.fn(),
}));

// Mock node:util (promisify is used in the handler)
vi.mock("node:util", () => ({
	promisify: (fn: any) => fn,
}));

// Mock node:fs
vi.mock("node:fs", () => ({
	existsSync: vi.fn(),
	mkdirSync: vi.fn(),
	rmSync: vi.fn(),
}));

describe("handleRepository", () => {
	const mockExec = vi.mocked(exec);
	const mockExistsSync = vi.mocked(existsSync);
	const cyrusHome = "/test/cyrus/home";

	beforeEach(() => {
		vi.clearAllMocks();
		// Default: repos directory exists
		mockExistsSync.mockReturnValue(false);
	});

	afterEach(() => {
		vi.resetAllMocks();
	});

	describe("gh repo clone command format", () => {
		it("should use org/repo format instead of full HTTPS URL for gh repo clone", async () => {
			// This test reproduces the bug from CYPACK-641
			// The bug: gh repo clone is called with full HTTPS URL which fails
			// Expected: gh repo clone should use "org/repo" format
			const payload: RepositoryPayload = {
				repository_url: "https://github.com/PlanetNineStudio/odins-obelisk",
				repository_name: "odins-obelisk",
			};

			// Mock: repos directory exists, repo path doesn't exist
			mockExistsSync.mockImplementation((path) => {
				const pathStr = String(path);
				if (pathStr === join(cyrusHome, "repos")) return true;
				if (pathStr === join(cyrusHome, "repos", "odins-obelisk")) return false;
				if (pathStr === join(cyrusHome, "repos", "odins-obelisk", ".git"))
					return true;
				return false;
			});

			let capturedCommand = "";
			mockExec.mockImplementation((cmd: string, _callback?: any) => {
				capturedCommand = cmd;
				return Promise.resolve({ stdout: "", stderr: "" });
			});

			await handleRepository(payload, cyrusHome);

			// BUG: Currently the code generates:
			// gh repo clone "https://github.com/PlanetNineStudio/odins-obelisk" "/test/cyrus/home/repos/odins-obelisk"
			//
			// EXPECTED: It should generate:
			// gh repo clone "PlanetNineStudio/odins-obelisk" "/test/cyrus/home/repos/odins-obelisk"
			expect(capturedCommand).toBe(
				`gh repo clone "PlanetNineStudio/odins-obelisk" "${join(cyrusHome, "repos", "odins-obelisk")}"`,
			);
		});

		it("should extract org/repo from HTTPS URL with .git suffix", async () => {
			const payload: RepositoryPayload = {
				repository_url: "https://github.com/ceedaragents/cyrus.git",
				repository_name: "cyrus",
			};

			mockExistsSync.mockImplementation((path) => {
				const pathStr = String(path);
				if (pathStr === join(cyrusHome, "repos")) return true;
				if (pathStr === join(cyrusHome, "repos", "cyrus")) return false;
				if (pathStr === join(cyrusHome, "repos", "cyrus", ".git")) return true;
				return false;
			});

			let capturedCommand = "";
			mockExec.mockImplementation((cmd: string, _callback?: any) => {
				capturedCommand = cmd;
				return Promise.resolve({ stdout: "", stderr: "" });
			});

			await handleRepository(payload, cyrusHome);

			expect(capturedCommand).toBe(
				`gh repo clone "ceedaragents/cyrus" "${join(cyrusHome, "repos", "cyrus")}"`,
			);
		});

		it("should handle SSH URLs by extracting org/repo format", async () => {
			const payload: RepositoryPayload = {
				repository_url: "git@github.com:ceedaragents/cyrus.git",
				repository_name: "cyrus",
			};

			mockExistsSync.mockImplementation((path) => {
				const pathStr = String(path);
				if (pathStr === join(cyrusHome, "repos")) return true;
				if (pathStr === join(cyrusHome, "repos", "cyrus")) return false;
				if (pathStr === join(cyrusHome, "repos", "cyrus", ".git")) return true;
				return false;
			});

			let capturedCommand = "";
			mockExec.mockImplementation((cmd: string, _callback?: any) => {
				capturedCommand = cmd;
				return Promise.resolve({ stdout: "", stderr: "" });
			});

			await handleRepository(payload, cyrusHome);

			expect(capturedCommand).toBe(
				`gh repo clone "ceedaragents/cyrus" "${join(cyrusHome, "repos", "cyrus")}"`,
			);
		});
	});

	describe("validation", () => {
		it("should return error when repository URL is missing", async () => {
			const payload = {} as RepositoryPayload;

			const result = await handleRepository(payload, cyrusHome);

			expect(result).toEqual({
				success: false,
				error: "Repository URL is required",
				details:
					"Please provide a valid Git repository URL (e.g., https://github.com/user/repo.git)",
			});
		});

		it("should return error when repository URL is not a string", async () => {
			const payload = { repository_url: 123 } as unknown as RepositoryPayload;

			const result = await handleRepository(payload, cyrusHome);

			expect(result).toEqual({
				success: false,
				error: "Repository URL is required",
				details:
					"Please provide a valid Git repository URL (e.g., https://github.com/user/repo.git)",
			});
		});
	});

	describe("existing repository", () => {
		it("should return success when repository already exists and is valid git repo", async () => {
			const payload: RepositoryPayload = {
				repository_url: "https://github.com/org/repo",
				repository_name: "repo",
			};

			mockExistsSync.mockImplementation((path) => {
				const pathStr = String(path);
				if (pathStr === join(cyrusHome, "repos")) return true;
				if (pathStr === join(cyrusHome, "repos", "repo")) return true;
				if (pathStr === join(cyrusHome, "repos", "repo", ".git")) return true;
				return false;
			});

			const result = await handleRepository(payload, cyrusHome);

			expect(result).toEqual({
				success: true,
				message: "Repository already exists",
				data: {
					path: join(cyrusHome, "repos", "repo"),
					name: "repo",
					action: "verified",
				},
			});
			expect(mockExec).not.toHaveBeenCalled();
		});

		it("should return error when path exists but is not a git repository", async () => {
			const payload: RepositoryPayload = {
				repository_url: "https://github.com/org/repo",
				repository_name: "repo",
			};

			mockExistsSync.mockImplementation((path) => {
				const pathStr = String(path);
				if (pathStr === join(cyrusHome, "repos")) return true;
				if (pathStr === join(cyrusHome, "repos", "repo")) return true;
				if (pathStr === join(cyrusHome, "repos", "repo", ".git")) return false;
				return false;
			});

			const result = await handleRepository(payload, cyrusHome);

			expect(result).toEqual({
				success: false,
				error: "Directory exists but is not a Git repository",
				details: `A non-Git directory already exists at ${join(cyrusHome, "repos", "repo")}. Please remove it manually or choose a different repository name.`,
			});
		});
	});

	describe("clone errors", () => {
		it("should return error when clone fails", async () => {
			const payload: RepositoryPayload = {
				repository_url: "https://github.com/org/repo",
				repository_name: "repo",
			};

			mockExistsSync.mockImplementation((path) => {
				const pathStr = String(path);
				if (pathStr === join(cyrusHome, "repos")) return true;
				return false;
			});

			mockExec.mockImplementation(() => {
				return Promise.reject(new Error("Clone failed: network timeout"));
			});

			const result = await handleRepository(payload, cyrusHome);

			expect(result.success).toBe(false);
			expect(result.error).toBe("Failed to clone repository");
			expect(result.details).toContain("Clone failed: network timeout");
		});
	});
});

describe("handleRepositoryDelete", () => {
	const mockExistsSync = vi.mocked(existsSync);
	const mockRmSync = vi.mocked(rmSync);
	const cyrusHome = "/test/cyrus/home";

	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.resetAllMocks();
	});

	describe("validation", () => {
		it("should return error when repository name is missing", async () => {
			const payload = {} as DeleteRepositoryPayload;

			const result = await handleRepositoryDelete(payload, cyrusHome);

			expect(result).toEqual({
				success: false,
				error: "Repository name is required",
				details:
					"Please provide a valid repository name to delete (e.g., 'my-repo')",
			});
		});
	});

	describe("deletion", () => {
		it("should return success when repository does not exist", async () => {
			const payload: DeleteRepositoryPayload = {
				repository_name: "nonexistent",
			};

			mockExistsSync.mockReturnValue(false);

			const result = await handleRepositoryDelete(payload, cyrusHome);

			expect(result).toEqual({
				success: true,
				message: "Repository does not exist (already deleted)",
				data: {
					name: "nonexistent",
					action: "skipped",
				},
			});
		});

		it("should delete repository when it exists", async () => {
			const payload: DeleteRepositoryPayload = {
				repository_name: "myrepo",
			};

			mockExistsSync.mockImplementation((path) => {
				const pathStr = String(path);
				if (pathStr === join(cyrusHome, "repos", "myrepo")) return true;
				return false;
			});

			const result = await handleRepositoryDelete(payload, cyrusHome);

			expect(result).toEqual({
				success: true,
				message: "Repository deleted successfully",
				data: {
					name: "myrepo",
					path: join(cyrusHome, "repos", "myrepo"),
					action: "deleted",
					worktrees_deleted: [],
				},
			});
			expect(mockRmSync).toHaveBeenCalledWith(
				join(cyrusHome, "repos", "myrepo"),
				{ recursive: true, force: true },
			);
		});

		it("should also delete worktrees when linear_team_key is provided", async () => {
			const payload: DeleteRepositoryPayload = {
				repository_name: "myrepo",
				linear_team_key: "TEAM",
			};

			mockExistsSync.mockImplementation((path) => {
				const pathStr = String(path);
				if (pathStr === join(cyrusHome, "repos", "myrepo")) return true;
				if (pathStr === join(cyrusHome, "workspaces", "TEAM", "myrepo"))
					return true;
				return false;
			});

			const result = await handleRepositoryDelete(payload, cyrusHome);

			expect(result).toEqual({
				success: true,
				message: "Repository deleted successfully",
				data: {
					name: "myrepo",
					path: join(cyrusHome, "repos", "myrepo"),
					action: "deleted",
					worktrees_deleted: [join(cyrusHome, "workspaces", "TEAM", "myrepo")],
				},
			});
			expect(mockRmSync).toHaveBeenCalledTimes(2);
		});
	});
});
