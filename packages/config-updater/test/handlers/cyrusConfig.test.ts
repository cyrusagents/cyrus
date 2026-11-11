import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleCyrusConfig } from "../../src/handlers/cyrusConfig.js";

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

describe("handleCyrusConfig", () => {
	const cyrusHome = "/test/cyrus-home";

	beforeEach(() => {
		vi.clearAllMocks();
		delete process.env.CYRUS_WORKTREES_DIR;
		mockExistsSync.mockReturnValue(false);
		mockReadFileSync.mockReturnValue("");
	});

	afterEach(() => {
		delete process.env.CYRUS_WORKTREES_DIR;
	});

	it.each([
		true,
		false,
		undefined,
	])("preserves CI opt-in %s in pushed config without requesting a restart", async (ciFailureTrigger) => {
		const result = await handleCyrusConfig(
			{ repositories: [], ciFailureTrigger },
			cyrusHome,
		);
		expect(result.success).toBe(true);
		const saved = JSON.parse(mockWriteFileSync.mock.calls[0]![1] as string);
		expect(saved.ciFailureTrigger).toBe(ciFailureTrigger);
		expect(result.data).toMatchObject({ restartCyrus: false });
	});

	it("defaults repository workspaceBaseDir to cyrusHome/worktrees", async () => {
		const result = await handleCyrusConfig(
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
			cyrusHome,
		);

		expect(result.success).toBe(true);
		expect(mockMkdirSync).toHaveBeenCalledWith(cyrusHome, { recursive: true });
		expect(mockWriteFileSync).toHaveBeenCalledWith(
			"/test/cyrus-home/config.json",
			expect.stringContaining(
				'"workspaceBaseDir": "/test/cyrus-home/worktrees"',
			),
			"utf-8",
		);
	});

	it("uses CYRUS_WORKTREES_DIR when set", async () => {
		process.env.CYRUS_WORKTREES_DIR = "/tmp/custom-worktrees";

		const result = await handleCyrusConfig(
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
			cyrusHome,
		);

		expect(result.success).toBe(true);
		expect(mockWriteFileSync).toHaveBeenCalledWith(
			"/test/cyrus-home/config.json",
			expect.stringContaining('"workspaceBaseDir": "/tmp/custom-worktrees"'),
			"utf-8",
		);
	});
});
