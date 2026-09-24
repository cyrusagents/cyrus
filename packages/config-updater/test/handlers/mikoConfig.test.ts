import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleMikoConfig } from "../../src/handlers/mikoConfig.js";

vi.mock("node:fs", () => ({
	existsSync: vi.fn(() => false),
	mkdirSync: vi.fn(),
	readFileSync: vi.fn(),
	writeFileSync: vi.fn(),
}));

const mockExistsSync = vi.mocked(existsSync);
const mockMkdirSync = vi.mocked(mkdirSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockWriteFileSync = vi.mocked(writeFileSync);

describe("handleMikoConfig", () => {
	const mikoHome = "/test/miko-home";

	beforeEach(() => {
		vi.clearAllMocks();
		delete process.env.MIKO_WORKTREES_DIR;
		mockExistsSync.mockReturnValue(false);
		mockReadFileSync.mockReturnValue("");
	});

	afterEach(() => {
		delete process.env.MIKO_WORKTREES_DIR;
	});

	it("defaults repository workspaceBaseDir to mikoHome/worktrees", async () => {
		const result = await handleMikoConfig(
			{
				repositories: [
					{
						id: "repo-1",
						name: "repo-1",
						repositoryPath: "/repos/repo-1",
						baseBranch: "main",
					},
				],
			},
			mikoHome,
		);

		expect(result.success).toBe(true);
		expect(mockMkdirSync).toHaveBeenCalledWith(mikoHome, { recursive: true });
		expect(mockWriteFileSync).toHaveBeenCalledWith(
			"/test/miko-home/config.json",
			expect.stringContaining(
				'"workspaceBaseDir": "/test/miko-home/worktrees"',
			),
			"utf-8",
		);
	});

	it("uses MIKO_WORKTREES_DIR when set", async () => {
		process.env.MIKO_WORKTREES_DIR = "/tmp/custom-worktrees";

		const result = await handleMikoConfig(
			{
				repositories: [
					{
						id: "repo-1",
						name: "repo-1",
						repositoryPath: "/repos/repo-1",
						baseBranch: "main",
					},
				],
			},
			mikoHome,
		);

		expect(result.success).toBe(true);
		expect(mockWriteFileSync).toHaveBeenCalledWith(
			"/test/miko-home/config.json",
			expect.stringContaining('"workspaceBaseDir": "/tmp/custom-worktrees"'),
			"utf-8",
		);
	});
});
