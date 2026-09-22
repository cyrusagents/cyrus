import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleAtmikoConfig } from "../../src/handlers/atmikoConfig.js";

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

describe("handleAtmikoConfig", () => {
	const atmikoHome = "/test/atmiko-home";

	beforeEach(() => {
		vi.clearAllMocks();
		delete process.env.ATMIKO_WORKTREES_DIR;
		mockExistsSync.mockReturnValue(false);
		mockReadFileSync.mockReturnValue("");
	});

	afterEach(() => {
		delete process.env.ATMIKO_WORKTREES_DIR;
	});

	it("defaults repository workspaceBaseDir to atmikoHome/worktrees", async () => {
		const result = await handleAtmikoConfig(
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
			atmikoHome,
		);

		expect(result.success).toBe(true);
		expect(mockMkdirSync).toHaveBeenCalledWith(atmikoHome, { recursive: true });
		expect(mockWriteFileSync).toHaveBeenCalledWith(
			"/test/atmiko-home/config.json",
			expect.stringContaining(
				'"workspaceBaseDir": "/test/atmiko-home/worktrees"',
			),
			"utf-8",
		);
	});

	it("uses ATMIKO_WORKTREES_DIR when set", async () => {
		process.env.ATMIKO_WORKTREES_DIR = "/tmp/custom-worktrees";

		const result = await handleAtmikoConfig(
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
			atmikoHome,
		);

		expect(result.success).toBe(true);
		expect(mockWriteFileSync).toHaveBeenCalledWith(
			"/test/atmiko-home/config.json",
			expect.stringContaining('"workspaceBaseDir": "/tmp/custom-worktrees"'),
			"utf-8",
		);
	});
});
