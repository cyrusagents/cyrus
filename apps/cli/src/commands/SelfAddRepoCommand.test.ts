import { beforeEach, describe, expect, it, vi } from "vitest";

// Use vi.hoisted to create mock functions that can be used in vi.mock
const mocks = vi.hoisted(() => ({
	mockExecSync: vi.fn(),
	mockRandomUUID: vi.fn(),
	mockExistsSync: vi.fn(),
	mockReadFileSync: vi.fn(),
	mockWriteFileSync: vi.fn(),
	mockQuestion: vi.fn(),
	mockClose: vi.fn(),
}));

// Mock modules
vi.mock("node:child_process", () => ({
	execSync: mocks.mockExecSync,
}));

vi.mock("node:crypto", () => ({
	randomUUID: mocks.mockRandomUUID,
}));

vi.mock("node:fs", () => ({
	existsSync: mocks.mockExistsSync,
	readFileSync: mocks.mockReadFileSync,
	writeFileSync: mocks.mockWriteFileSync,
}));

vi.mock("node:path", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:path")>();
	return {
		...actual,
		resolve: vi.fn((...parts: string[]) => parts.join("/")),
	};
});

vi.mock("node:readline", () => ({
	createInterface: vi.fn(() => ({
		question: mocks.mockQuestion,
		close: mocks.mockClose,
	})),
}));

// Mock process.exit
const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
	throw new Error("process.exit called");
});

// Mock console methods
const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

// Import after mocks
import {
	detectDefaultBranch,
	SelfAddRepoCommand,
} from "./SelfAddRepoCommand.js";

// Mock Application
const createMockApp = () => ({
	cyrusHome: "/home/user/.cyrus",
	config: {
		exists: vi.fn().mockReturnValue(true),
		load: vi.fn(),
		update: vi.fn(),
	},
	logger: {
		info: vi.fn(),
		error: vi.fn(),
		warn: vi.fn(),
		success: vi.fn(),
		divider: vi.fn(),
	},
});

describe("SelfAddRepoCommand", () => {
	let mockApp: ReturnType<typeof createMockApp>;
	let command: SelfAddRepoCommand;

	beforeEach(() => {
		vi.clearAllMocks();
		mockApp = createMockApp();
		command = new SelfAddRepoCommand(mockApp as any);
		mocks.mockRandomUUID.mockReturnValue("generated-uuid-123");
		mocks.mockExistsSync.mockReturnValue(false);
		mocks.mockExecSync.mockReturnValue("");
	});

	describe("Config File Validation", () => {
		it("should error when config file does not exist", async () => {
			mocks.mockReadFileSync.mockImplementation(() => {
				throw new Error("ENOENT: no such file or directory");
			});

			await expect(
				command.execute(["https://github.com/user/repo.git"]),
			).rejects.toThrow("process.exit called");
			expect(mockExit).toHaveBeenCalledWith(1);
		});

		it("should error when config file is invalid JSON", async () => {
			mocks.mockReadFileSync.mockReturnValue("invalid json{");

			await expect(
				command.execute(["https://github.com/user/repo.git"]),
			).rejects.toThrow("process.exit called");
			expect(mockExit).toHaveBeenCalledWith(1);
		});
	});

	describe("URL Handling", () => {
		it("should prompt for URL when not provided", async () => {
			mocks.mockReadFileSync.mockReturnValue(
				JSON.stringify({
					linearWorkspaces: {
						"ws-123": {
							linearToken: "token",
							linearRefreshToken: "refresh",
							linearWorkspaceName: "Test Workspace",
						},
					},
					repositories: [],
				}),
			);

			mocks.mockQuestion.mockImplementation(
				(_question: string, callback: (answer: string) => void) => {
					callback("https://github.com/user/prompted-repo.git");
				},
			);

			await expect(command.execute([])).rejects.toThrow("process.exit called");
			expect(mockExit).toHaveBeenCalledWith(0);

			expect(mocks.mockQuestion).toHaveBeenCalledWith(
				"Repository URL: ",
				expect.any(Function),
			);

			const writtenConfig = JSON.parse(
				mocks.mockWriteFileSync.mock.calls[0][1],
			);
			const addedRepo = writtenConfig.repositories.find(
				(r: any) => r.id === "generated-uuid-123",
			);
			expect(addedRepo.name).toBe("prompted-repo");
		});

		it("should error when prompted URL is empty", async () => {
			mocks.mockReadFileSync.mockReturnValue(
				JSON.stringify({
					linearWorkspaces: {
						"ws-123": {
							linearToken: "token",
							linearRefreshToken: "refresh",
							linearWorkspaceName: "Test Workspace",
						},
					},
					repositories: [],
				}),
			);

			mocks.mockQuestion.mockImplementation(
				(_question: string, callback: (answer: string) => void) => {
					callback("");
				},
			);

			await expect(command.execute([])).rejects.toThrow("process.exit called");
			expect(mockExit).toHaveBeenCalledWith(1);
			expect(mockApp.logger.error).toHaveBeenCalledWith("URL is required");
		});

		it("should extract repo name from URL correctly", async () => {
			mocks.mockReadFileSync.mockReturnValue(
				JSON.stringify({
					repositories: [
						{
							linearWorkspaceId: "ws-123",
							linearToken: "token",
							linearRefreshToken: "refresh",
						},
					],
				}),
			);

			await expect(
				command.execute(["https://github.com/user/my-awesome-repo.git"]),
			).rejects.toThrow("process.exit called");
			expect(mockExit).toHaveBeenCalledWith(0);

			const writtenConfig = JSON.parse(
				mocks.mockWriteFileSync.mock.calls[0][1],
			);
			const addedRepo = writtenConfig.repositories.find(
				(r: any) => r.id === "generated-uuid-123",
			);
			expect(addedRepo.name).toBe("my-awesome-repo");
		});

		it("should handle URL without .git suffix", async () => {
			mocks.mockReadFileSync.mockReturnValue(
				JSON.stringify({
					repositories: [
						{
							linearWorkspaceId: "ws-123",
							linearToken: "token",
							linearRefreshToken: "refresh",
						},
					],
				}),
			);

			await expect(
				command.execute(["https://github.com/user/repo-no-git"]),
			).rejects.toThrow("process.exit called");
			expect(mockExit).toHaveBeenCalledWith(0);

			const writtenConfig = JSON.parse(
				mocks.mockWriteFileSync.mock.calls[0][1],
			);
			const addedRepo = writtenConfig.repositories.find(
				(r: any) => r.id === "generated-uuid-123",
			);
			expect(addedRepo.name).toBe("repo-no-git");
		});
	});

	describe("Duplicate Detection", () => {
		it("should error when repository already exists", async () => {
			mocks.mockReadFileSync.mockReturnValue(
				JSON.stringify({
					repositories: [
						{
							id: "existing",
							name: "existing-repo",
							linearWorkspaceId: "ws-123",
							linearToken: "token",
						},
					],
				}),
			);

			await expect(
				command.execute(["https://github.com/user/existing-repo.git"]),
			).rejects.toThrow("process.exit called");
			expect(mockExit).toHaveBeenCalledWith(1);
			expect(mockApp.logger.error).toHaveBeenCalledWith(
				expect.stringContaining("already exists"),
			);
		});
	});

	describe("Linear Credentials", () => {
		it("should error when no Linear credentials exist", async () => {
			mocks.mockReadFileSync.mockReturnValue(
				JSON.stringify({
					repositories: [
						{
							id: "repo-1",
							name: "other",
							linearWorkspaceId: "",
							linearToken: "",
						},
					],
				}),
			);

			await expect(
				command.execute(["https://github.com/user/new-repo.git"]),
			).rejects.toThrow("process.exit called");
			expect(mockExit).toHaveBeenCalledWith(1);
			expect(mockApp.logger.error).toHaveBeenCalledWith(
				expect.stringContaining("No Linear credentials found"),
			);
		});

		it("should error when repositories array is empty", async () => {
			mocks.mockReadFileSync.mockReturnValue(
				JSON.stringify({
					repositories: [],
				}),
			);

			await expect(
				command.execute(["https://github.com/user/new-repo.git"]),
			).rejects.toThrow("process.exit called");
			expect(mockExit).toHaveBeenCalledWith(1);
		});
	});

	describe("Workspace Selection", () => {
		it("should auto-select when only one workspace exists", async () => {
			mocks.mockReadFileSync.mockReturnValue(
				JSON.stringify({
					linearWorkspaces: {
						"ws-only": {
							linearToken: "token-1",
							linearRefreshToken: "refresh-1",
							linearWorkspaceName: "Only Workspace",
						},
					},
					repositories: [
						{
							id: "repo-1",
							name: "existing",
							linearWorkspaceId: "ws-only",
						},
					],
				}),
			);

			await expect(
				command.execute(["https://github.com/user/new-repo.git"]),
			).rejects.toThrow("process.exit called");
			expect(mockExit).toHaveBeenCalledWith(0);

			// Should not prompt for workspace
			expect(mocks.mockQuestion).not.toHaveBeenCalledWith(
				expect.stringContaining("Select workspace"),
				expect.any(Function),
			);

			const writtenConfig = JSON.parse(
				mocks.mockWriteFileSync.mock.calls[0][1],
			);
			const addedRepo = writtenConfig.repositories.find(
				(r: any) => r.id === "generated-uuid-123",
			);
			expect(addedRepo.linearWorkspaceId).toBe("ws-only");
		});

		it("should prompt when multiple workspaces exist", async () => {
			mocks.mockReadFileSync.mockReturnValue(
				JSON.stringify({
					linearWorkspaces: {
						"ws-1": {
							linearToken: "token-1",
							linearRefreshToken: "refresh-1",
							linearWorkspaceName: "Workspace One",
						},
						"ws-2": {
							linearToken: "token-2",
							linearRefreshToken: "refresh-2",
							linearWorkspaceName: "Workspace Two",
						},
					},
					repositories: [
						{
							id: "repo-1",
							linearWorkspaceId: "ws-1",
						},
						{
							id: "repo-2",
							linearWorkspaceId: "ws-2",
						},
					],
				}),
			);

			mocks.mockQuestion.mockImplementation(
				(_question: string, callback: (answer: string) => void) => {
					callback("2"); // Select second workspace
				},
			);

			await expect(
				command.execute(["https://github.com/user/new-repo.git"]),
			).rejects.toThrow("process.exit called");
			expect(mockExit).toHaveBeenCalledWith(0);

			const writtenConfig = JSON.parse(
				mocks.mockWriteFileSync.mock.calls[0][1],
			);
			const addedRepo = writtenConfig.repositories.find(
				(r: any) => r.id === "generated-uuid-123",
			);
			expect(addedRepo.linearWorkspaceId).toBe("ws-2");
		});

		it("should use workspace from command line argument", async () => {
			mocks.mockReadFileSync.mockReturnValue(
				JSON.stringify({
					linearWorkspaces: {
						"ws-1": {
							linearToken: "token-1",
							linearRefreshToken: "refresh-1",
							linearWorkspaceName: "Workspace One",
						},
						"ws-2": {
							linearToken: "token-2",
							linearRefreshToken: "refresh-2",
							linearWorkspaceName: "Workspace Two",
						},
					},
					repositories: [
						{
							id: "repo-1",
							linearWorkspaceId: "ws-1",
						},
						{
							id: "repo-2",
							linearWorkspaceId: "ws-2",
						},
					],
				}),
			);

			await expect(
				command.execute([
					"https://github.com/user/new-repo.git",
					"Workspace Two",
				]),
			).rejects.toThrow("process.exit called");
			expect(mockExit).toHaveBeenCalledWith(0);

			// Should not prompt
			expect(mocks.mockQuestion).not.toHaveBeenCalled();

			const writtenConfig = JSON.parse(
				mocks.mockWriteFileSync.mock.calls[0][1],
			);
			const addedRepo = writtenConfig.repositories.find(
				(r: any) => r.id === "generated-uuid-123",
			);
			expect(addedRepo.linearWorkspaceId).toBe("ws-2");
		});

		it("should error when specified workspace not found", async () => {
			// Need multiple workspaces to avoid auto-selection
			mocks.mockReadFileSync.mockReturnValue(
				JSON.stringify({
					linearWorkspaces: {
						"ws-1": {
							linearToken: "token-1",
							linearWorkspaceName: "Workspace One",
						},
						"ws-2": {
							linearToken: "token-2",
							linearWorkspaceName: "Workspace Two",
						},
					},
					repositories: [
						{
							id: "repo-1",
							linearWorkspaceId: "ws-1",
						},
						{
							id: "repo-2",
							linearWorkspaceId: "ws-2",
						},
					],
				}),
			);

			await expect(
				command.execute([
					"https://github.com/user/new-repo.git",
					"Nonexistent Workspace",
				]),
			).rejects.toThrow("process.exit called");
			expect(mockExit).toHaveBeenCalledWith(1);
			expect(mockApp.logger.error).toHaveBeenCalledWith(
				expect.stringContaining("not found"),
			);
		});

		it("should error on invalid workspace selection", async () => {
			mocks.mockReadFileSync.mockReturnValue(
				JSON.stringify({
					linearWorkspaces: {
						"ws-1": {
							linearToken: "token-1",
							linearWorkspaceName: "Workspace One",
						},
						"ws-2": {
							linearToken: "token-2",
							linearWorkspaceName: "Workspace Two",
						},
					},
					repositories: [
						{
							id: "repo-1",
							linearWorkspaceId: "ws-1",
						},
						{
							id: "repo-2",
							linearWorkspaceId: "ws-2",
						},
					],
				}),
			);

			mocks.mockQuestion.mockImplementation(
				(_question: string, callback: (answer: string) => void) => {
					callback("99"); // Invalid selection
				},
			);

			await expect(
				command.execute(["https://github.com/user/new-repo.git"]),
			).rejects.toThrow("process.exit called");
			expect(mockExit).toHaveBeenCalledWith(1);
		});
	});

	describe("Git Clone", () => {
		it("should clone repository to correct path", async () => {
			mocks.mockReadFileSync.mockReturnValue(
				JSON.stringify({
					repositories: [
						{
							linearWorkspaceId: "ws-123",
							linearToken: "token",
							linearRefreshToken: "refresh",
						},
					],
				}),
			);

			await expect(
				command.execute(["https://github.com/user/my-repo.git"]),
			).rejects.toThrow("process.exit called");
			expect(mockExit).toHaveBeenCalledWith(0);

			expect(mocks.mockExecSync).toHaveBeenCalledWith(
				"git clone https://github.com/user/my-repo.git /home/user/.cyrus/repos/my-repo",
				{ stdio: "inherit" },
			);
		});

		it("should skip clone if repository directory already exists", async () => {
			mocks.mockReadFileSync.mockReturnValue(
				JSON.stringify({
					repositories: [
						{
							linearWorkspaceId: "ws-123",
							linearToken: "token",
							linearRefreshToken: "refresh",
						},
					],
				}),
			);

			mocks.mockExistsSync.mockReturnValue(true); // Directory exists

			await expect(
				command.execute(["https://github.com/user/existing-dir.git"]),
			).rejects.toThrow("process.exit called");
			expect(mockExit).toHaveBeenCalledWith(0);

			// Should not call git clone (but execSync may be called for branch detection)
			expect(mocks.mockExecSync).not.toHaveBeenCalledWith(
				expect.stringContaining("git clone"),
				expect.anything(),
			);
			expect(mockConsoleLog).toHaveBeenCalledWith(
				expect.stringContaining("already exists"),
			);
		});

		it("should error when git clone fails", async () => {
			mocks.mockReadFileSync.mockReturnValue(
				JSON.stringify({
					repositories: [
						{
							linearWorkspaceId: "ws-123",
							linearToken: "token",
							linearRefreshToken: "refresh",
						},
					],
				}),
			);

			mocks.mockExecSync.mockImplementation(() => {
				throw new Error("git clone failed");
			});

			await expect(
				command.execute(["https://github.com/user/fail-repo.git"]),
			).rejects.toThrow("process.exit called");
			expect(mockExit).toHaveBeenCalledWith(1);
		});
	});

	describe("Config Update", () => {
		it("should add repository with correct fields", async () => {
			mocks.mockReadFileSync.mockReturnValue(
				JSON.stringify({
					linearWorkspaces: {
						"ws-123": {
							linearToken: "existing-token",
							linearRefreshToken: "existing-refresh",
							linearWorkspaceName: "Test Workspace",
						},
					},
					repositories: [
						{
							id: "existing",
							linearWorkspaceId: "ws-123",
						},
					],
				}),
			);

			await expect(
				command.execute(["https://github.com/user/new-repo.git"]),
			).rejects.toThrow("process.exit called");
			expect(mockExit).toHaveBeenCalledWith(0);

			expect(mocks.mockWriteFileSync).toHaveBeenCalled();
			const writtenConfig = JSON.parse(
				mocks.mockWriteFileSync.mock.calls[0][1],
			);

			const addedRepo = writtenConfig.repositories.find(
				(r: any) => r.id === "generated-uuid-123",
			);

			expect(addedRepo).toEqual({
				id: "generated-uuid-123",
				name: "new-repo",
				repositoryPath: "/home/user/.cyrus/repos/new-repo",
				baseBranch: "main",
				workspaceBaseDir: "/home/user/.cyrus/worktrees",
				linearWorkspaceId: "ws-123",
				isActive: true,
				routingLabels: ["new-repo"],
				githubUrl: "https://github.com/user/new-repo",
			});
		});

		it("should use custom routing labels when -l flag is provided", async () => {
			mocks.mockReadFileSync.mockReturnValue(
				JSON.stringify({
					linearWorkspaces: {
						"ws-123": {
							linearToken: "existing-token",
							linearRefreshToken: "existing-refresh",
							linearWorkspaceName: "Test Workspace",
						},
					},
					repositories: [
						{
							id: "existing",
							linearWorkspaceId: "ws-123",
						},
					],
				}),
			);

			await expect(
				command.execute([
					"https://github.com/user/new-repo.git",
					"-l",
					"custom-label,another-label",
				]),
			).rejects.toThrow("process.exit called");
			expect(mockExit).toHaveBeenCalledWith(0);

			expect(mocks.mockWriteFileSync).toHaveBeenCalled();
			const writtenConfig = JSON.parse(
				mocks.mockWriteFileSync.mock.calls[0][1],
			);

			const addedRepo = writtenConfig.repositories.find(
				(r: any) => r.id === "generated-uuid-123",
			);

			expect(addedRepo.routingLabels).toEqual([
				"custom-label",
				"another-label",
			]);
		});

		it("should preserve existing repositories", async () => {
			mocks.mockReadFileSync.mockReturnValue(
				JSON.stringify({
					repositories: [
						{
							id: "existing-1",
							name: "repo-1",
							linearWorkspaceId: "ws-123",
							linearToken: "token-1",
							linearRefreshToken: "refresh-1",
						},
						{
							id: "existing-2",
							name: "repo-2",
							linearWorkspaceId: "ws-456",
							linearToken: "token-2",
							linearRefreshToken: "refresh-2",
						},
					],
				}),
			);

			await expect(
				command.execute(["https://github.com/user/new-repo.git", "ws-123"]),
			).rejects.toThrow("process.exit called");

			const writtenConfig = JSON.parse(
				mocks.mockWriteFileSync.mock.calls[0][1],
			);
			expect(writtenConfig.repositories).toHaveLength(3);
			expect(writtenConfig.repositories[0].id).toBe("existing-1");
			expect(writtenConfig.repositories[1].id).toBe("existing-2");
			expect(writtenConfig.repositories[2].id).toBe("generated-uuid-123");
		});

		it("should initialize empty repositories array if missing", async () => {
			mocks.mockReadFileSync.mockReturnValue(JSON.stringify({}));

			await expect(
				command.execute(["https://github.com/user/new-repo.git"]),
			).rejects.toThrow("process.exit called");
			expect(mockExit).toHaveBeenCalledWith(1); // No credentials
		});
	});

	describe("Base Branch Detection", () => {
		it("should auto-detect base branch from git symbolic-ref", async () => {
			mocks.mockReadFileSync.mockReturnValue(
				JSON.stringify({
					linearWorkspaces: {
						"ws-123": {
							linearToken: "token",
							linearRefreshToken: "refresh",
							linearWorkspaceName: "Test Workspace",
						},
					},
					repositories: [],
				}),
			);

			// Make execSync return the symbolic ref for branch detection
			mocks.mockExecSync.mockImplementation((cmd: string) => {
				if (cmd.includes("symbolic-ref")) {
					return "refs/remotes/origin/develop";
				}
				return "";
			});

			await expect(
				command.execute(["https://github.com/user/new-repo.git"]),
			).rejects.toThrow("process.exit called");
			expect(mockExit).toHaveBeenCalledWith(0);

			const writtenConfig = JSON.parse(
				mocks.mockWriteFileSync.mock.calls[0][1],
			);
			const addedRepo = writtenConfig.repositories.find(
				(r: any) => r.id === "generated-uuid-123",
			);
			expect(addedRepo.baseBranch).toBe("develop");
		});

		it("should use --base-branch flag over auto-detection", async () => {
			mocks.mockReadFileSync.mockReturnValue(
				JSON.stringify({
					linearWorkspaces: {
						"ws-123": {
							linearToken: "token",
							linearRefreshToken: "refresh",
							linearWorkspaceName: "Test Workspace",
						},
					},
					repositories: [],
				}),
			);

			// Even though symbolic-ref returns "develop", the flag should win
			mocks.mockExecSync.mockImplementation((cmd: string) => {
				if (cmd.includes("symbolic-ref")) {
					return "refs/remotes/origin/develop";
				}
				return "";
			});

			await expect(
				command.execute([
					"https://github.com/user/new-repo.git",
					"-b",
					"production",
				]),
			).rejects.toThrow("process.exit called");
			expect(mockExit).toHaveBeenCalledWith(0);

			const writtenConfig = JSON.parse(
				mocks.mockWriteFileSync.mock.calls[0][1],
			);
			const addedRepo = writtenConfig.repositories.find(
				(r: any) => r.id === "generated-uuid-123",
			);
			expect(addedRepo.baseBranch).toBe("production");
		});

		it("should fall back to 'main' when detection fails", async () => {
			mocks.mockReadFileSync.mockReturnValue(
				JSON.stringify({
					linearWorkspaces: {
						"ws-123": {
							linearToken: "token",
							linearRefreshToken: "refresh",
							linearWorkspaceName: "Test Workspace",
						},
					},
					repositories: [],
				}),
			);

			// Both detection methods fail
			mocks.mockExecSync.mockImplementation((cmd: string) => {
				if (cmd.includes("symbolic-ref") || cmd.includes("remote show")) {
					throw new Error("not set");
				}
				return "";
			});

			await expect(
				command.execute(["https://github.com/user/new-repo.git"]),
			).rejects.toThrow("process.exit called");
			expect(mockExit).toHaveBeenCalledWith(0);

			const writtenConfig = JSON.parse(
				mocks.mockWriteFileSync.mock.calls[0][1],
			);
			const addedRepo = writtenConfig.repositories.find(
				(r: any) => r.id === "generated-uuid-123",
			);
			expect(addedRepo.baseBranch).toBe("main");
		});
	});

	describe("detectDefaultBranch", () => {
		it("should parse branch from symbolic-ref output", () => {
			mocks.mockExecSync.mockReturnValue("refs/remotes/origin/master\n");
			expect(detectDefaultBranch("/some/path")).toBe("master");
		});

		it("should fall back to git remote show when symbolic-ref fails", () => {
			mocks.mockExecSync.mockImplementation((cmd: string) => {
				if (cmd.includes("symbolic-ref")) {
					throw new Error("not a symbolic ref");
				}
				return "  HEAD branch: staging\n  Remote branches:\n";
			});
			expect(detectDefaultBranch("/some/path")).toBe("staging");
		});

		it("should return default when both methods fail", () => {
			mocks.mockExecSync.mockImplementation(() => {
				throw new Error("failed");
			});
			expect(detectDefaultBranch("/some/path")).toBe("main");
		});
	});

	describe("Output Messages", () => {
		it("should log success with repo details", async () => {
			mocks.mockReadFileSync.mockReturnValue(
				JSON.stringify({
					linearWorkspaces: {
						"ws-123": {
							linearToken: "token",
							linearRefreshToken: "refresh",
							linearWorkspaceName: "My Workspace",
						},
					},
					repositories: [
						{
							linearWorkspaceId: "ws-123",
						},
					],
				}),
			);

			await expect(
				command.execute(["https://github.com/user/success-repo.git"]),
			).rejects.toThrow("process.exit called");
			expect(mockExit).toHaveBeenCalledWith(0);

			expect(mockConsoleLog).toHaveBeenCalledWith(
				expect.stringContaining("Added: success-repo"),
			);
			expect(mockConsoleLog).toHaveBeenCalledWith(
				expect.stringContaining("ID: generated-uuid-123"),
			);
			expect(mockConsoleLog).toHaveBeenCalledWith(
				expect.stringContaining("Workspace: My Workspace"),
			);
		});
	});
});
