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

	it("preserves locally provisioned linearUsers / prompterCredentialPolicy when a push omits them", async () => {
		const existing = {
			repositories: [],
			linearUsers: {
				"lin-ada": {
					displayName: "Ada",
					claude: {
						oauthToken: {
							file: "/test/cyrus-home/user-credentials/lin-ada/claude-oauth-token",
						},
					},
					github: { token: { env: "ADA_GH" }, login: "ada" },
				},
			},
			prompterCredentialPolicy: { followUpByOtherUser: "reject" },
		};
		mockExistsSync.mockImplementation(
			(path) => String(path) === "/test/cyrus-home/config.json",
		);
		mockReadFileSync.mockReturnValue(JSON.stringify(existing));

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
				strictMcpConfig: false,
			},
			cyrusHome,
		);

		expect(result.success).toBe(true);
		const written = JSON.parse(
			mockWriteFileSync.mock.calls.find(
				(call) => call[0] === "/test/cyrus-home/config.json",
			)?.[1] as string,
		);
		expect(written.linearUsers).toEqual(existing.linearUsers);
		expect(written.prompterCredentialPolicy).toEqual(
			existing.prompterCredentialPolicy,
		);
		expect(written.strictMcpConfig).toBe(false);
	});

	it("lets a payload that explicitly carries linearUsers win over the local block", async () => {
		mockExistsSync.mockImplementation(
			(path) => String(path) === "/test/cyrus-home/config.json",
		);
		mockReadFileSync.mockReturnValue(
			JSON.stringify({
				repositories: [],
				linearUsers: { "lin-old": { displayName: "Old" } },
			}),
		);

		await handleCyrusConfig(
			{
				repositories: [],
				linearUsers: { "lin-new": { displayName: "New" } },
			},
			cyrusHome,
		);

		const written = JSON.parse(
			mockWriteFileSync.mock.calls.find(
				(call) => call[0] === "/test/cyrus-home/config.json",
			)?.[1] as string,
		);
		expect(Object.keys(written.linearUsers)).toEqual(["lin-new"]);
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
