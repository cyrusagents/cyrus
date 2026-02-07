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

vi.mock("node:path", () => ({
	resolve: vi.fn((...parts) => parts.join("/")),
}));

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
import { SelfAddRepoCommand } from "./SelfAddRepoCommand.js";

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
					repositories: [
						{
							id: "existing",
							name: "existing-repo",
							linearWorkspaceId: "ws-123",
							linearToken: "token",
							linearRefreshToken: "refresh",
						},
					],
				}),
			);

			// Mock readline to provide URL
			mocks.mockQuestion.mockImplementation(
				(_question: string, callback: Function) => {
					callback("https://github.com/user/prompted-repo.git");
				},
			);

			await expect(command.execute([])).rejects.toThrow("process.exit called");
			expect(mockExit).toHaveBeenCalledWith(0);
			expect(mocks.mockQuestion).toHaveBeenCalledWith(
				"Repository URL: ",
				expect.any(Function),
			);
		});

		it("should error when URL is empty after prompt", async () => {
			mocks.mockReadFileSync.mockReturnValue(
				JSON.stringify({
					repositories: [{ linearWorkspaceId: "ws", linearToken: "tok" }],
				}),
			);

			mocks.mockQuestion.mockImplementation(
				(_question: string, callback: Function) => {
					callback(""); // Empty URL
				},
			);

			await expect(command.execute([])).rejects.toThrow("process.exit called");
			expect(mockExit).toHaveBeenCalledWith(1);
		});

		it("should extract repo name from URL correctly", async () => {
			mocks.mockReadFileSync.mockReturnValue(
				JSON.stringify({
					repositories: [
						{
							linearWorkspaceId: "ws-123",
							linearToken: "token",
							linearRefreshToken: "refresh",
							linearWorkspaceName: "Test",
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
					repositories: [
						{
							id: "repo-1",
							name: "existing",
							linearWorkspaceId: "ws-only",
							linearWorkspaceName: "Only Workspace",
							linearToken: "token-1",
							linearRefreshToken: "refresh-1",
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
					repositories: [
						{
							id: "repo-1",
							linearWorkspaceId: "ws-1",
							linearWorkspaceName: "Workspace One",
							linearToken: "token-1",
							linearRefreshToken: "refresh-1",
						},
						{
							id: "repo-2",
							linearWorkspaceId: "ws-2",
							linearWorkspaceName: "Workspace Two",
							linearToken: "token-2",
							linearRefreshToken: "refresh-2",
						},
					],
				}),
			);

			mocks.mockQuestion.mockImplementation(
				(_question: string, callback: Function) => {
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
			expect(addedRepo.linearToken).toBe("token-2");
		});

		it("should use workspace from command line argument", async () => {
			mocks.mockReadFileSync.mockReturnValue(
				JSON.stringify({
					repositories: [
						{
							id: "repo-1",
							linearWorkspaceId: "ws-1",
							linearWorkspaceName: "Workspace One",
							linearToken: "token-1",
							linearRefreshToken: "refresh-1",
						},
						{
							id: "repo-2",
							linearWorkspaceId: "ws-2",
							linearWorkspaceName: "Workspace Two",
							linearToken: "token-2",
							linearRefreshToken: "refresh-2",
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
					repositories: [
						{
							id: "repo-1",
							linearWorkspaceId: "ws-1",
							linearWorkspaceName: "Workspace One",
							linearToken: "token-1",
						},
						{
							id: "repo-2",
							linearWorkspaceId: "ws-2",
							linearWorkspaceName: "Workspace Two",
							linearToken: "token-2",
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
					repositories: [
						{
							id: "repo-1",
							linearWorkspaceId: "ws-1",
							linearWorkspaceName: "Workspace One",
							linearToken: "token-1",
						},
						{
							id: "repo-2",
							linearWorkspaceId: "ws-2",
							linearWorkspaceName: "Workspace Two",
							linearToken: "token-2",
						},
					],
				}),
			);

			mocks.mockQuestion.mockImplementation(
				(_question: string, callback: Function) => {
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

			// Should not call git clone
			expect(mocks.mockExecSync).not.toHaveBeenCalled();
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
					repositories: [
						{
							id: "existing",
							linearWorkspaceId: "ws-123",
							linearWorkspaceName: "Test Workspace",
							linearToken: "existing-token",
							linearRefreshToken: "existing-refresh",
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
				linearWorkspaceName: "Test Workspace",
				linearToken: "existing-token",
				linearRefreshToken: "existing-refresh",
				isActive: true,
				routingLabels: ["new-repo"],
			});
		});

		it("should use custom routing labels when -l flag is provided", async () => {
			mocks.mockReadFileSync.mockReturnValue(
				JSON.stringify({
					repositories: [
						{
							id: "existing",
							linearWorkspaceId: "ws-123",
							linearWorkspaceName: "Test Workspace",
							linearToken: "existing-token",
							linearRefreshToken: "existing-refresh",
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

	describe("Output Messages", () => {
		it("should log success with repo details", async () => {
			mocks.mockReadFileSync.mockReturnValue(
				JSON.stringify({
					repositories: [
						{
							linearWorkspaceId: "ws-123",
							linearWorkspaceName: "My Workspace",
							linearToken: "token",
							linearRefreshToken: "refresh",
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
