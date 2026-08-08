import { readFile } from "node:fs/promises";
import type { EdgeWorkerConfig, ILogger } from "cyrus-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigManager } from "../src/ConfigManager.js";

vi.mock("node:fs/promises");

describe("ConfigManager runnerFallbacks hot reload", () => {
	let logger: ILogger;
	const baseConfig = {
		proxyUrl: "http://localhost:3000",
		cyrusHome: "/tmp/cyrus-home",
		repositories: [
			{
				id: "repo-1",
				name: "Repo 1",
				repositoryPath: "/test/repo",
				baseBranch: "main",
				workspaceBaseDir: "/test/workspaces",
			},
		],
	} as unknown as EdgeWorkerConfig;

	beforeEach(() => {
		vi.clearAllMocks();
		logger = {
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			debug: vi.fn(),
		} as unknown as ILogger;
	});

	function manager(config = baseConfig): ConfigManager {
		return new ConfigManager(
			config,
			logger,
			"/tmp/cyrus-home/config.json",
			new Map(config.repositories.map((repo) => [repo.id, repo])),
		);
	}

	it("merges and detects a valid runnerFallbacks change", async () => {
		const fallbackPolicy = {
			claude: {
				runners: ["codex"],
				rateLimitTypes: ["five_hour"],
			},
		};
		const configManager = manager();
		vi.mocked(readFile).mockResolvedValue(
			JSON.stringify({
				repositories: baseConfig.repositories,
				runnerFallbacks: fallbackPolicy,
			}) as never,
		);

		const reloaded = await (configManager as any).loadConfigSafely();

		expect(reloaded.runnerFallbacks).toEqual(fallbackPolicy);
		expect((configManager as any).detectGlobalConfigChanges(reloaded)).toBe(
			true,
		);
	});

	it("rejects an invalid runnerFallbacks change", async () => {
		const configManager = manager();
		vi.mocked(readFile).mockResolvedValue(
			JSON.stringify({
				repositories: baseConfig.repositories,
				runnerFallbacks: {
					claude: {
						runners: ["codex"],
						rateLimitTypes: ["not_a_quota"],
					},
				},
			}) as never,
		);

		expect(await (configManager as any).loadConfigSafely()).toBeNull();
		expect(logger.error).toHaveBeenCalledWith(
			expect.stringContaining("runnerFallbacks"),
			expect.anything(),
		);
	});
});
