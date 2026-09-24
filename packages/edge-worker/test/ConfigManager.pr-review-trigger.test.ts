import { readFile } from "node:fs/promises";
import type { EdgeWorkerConfig, ILogger } from "miko-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigManager } from "../src/ConfigManager.js";

vi.mock("node:fs/promises");

/**
 * Tests for CYPACK-1273: ensure the `prReviewTrigger` flag participates in
 * the config hot-reload pipeline — both the merge in `loadConfigSafely()` and
 * the global-change detection in `detectGlobalConfigChanges()`. Without these,
 * a `prReviewTrigger` change written to config.json while Miko is running
 * would be silently dropped (see CLAUDE.md note #9).
 */
describe("ConfigManager - prReviewTrigger hot-reload (CYPACK-1273)", () => {
	let logger: ILogger;

	const baseConfig: EdgeWorkerConfig = {
		proxyUrl: "http://localhost:3000",
		mikoHome: "/tmp/miko-home",
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

	function makeManager(config: EdgeWorkerConfig): ConfigManager {
		return new ConfigManager(
			config,
			logger,
			"/tmp/miko-home/config.json",
			new Map(config.repositories.map((r) => [r.id, r])),
		);
	}

	beforeEach(() => {
		vi.clearAllMocks();
		logger = {
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			debug: vi.fn(),
		} as unknown as ILogger;
	});

	it("merges prReviewTrigger:false from the reloaded config file", async () => {
		const manager = makeManager(baseConfig);
		vi.mocked(readFile).mockResolvedValue(
			JSON.stringify({
				repositories: baseConfig.repositories,
				prReviewTrigger: false,
			}) as any,
		);

		const newConfig = await (manager as any).loadConfigSafely();

		expect(newConfig).not.toBeNull();
		expect(newConfig.prReviewTrigger).toBe(false);
	});

	it("detects a prReviewTrigger change as a global config change", () => {
		const manager = makeManager(baseConfig);

		const changed = (manager as any).detectGlobalConfigChanges({
			...baseConfig,
			prReviewTrigger: false,
		});

		expect(changed).toBe(true);
	});

	it("preserves an existing prReviewTrigger value when the file omits it", async () => {
		const manager = makeManager({ ...baseConfig, prReviewTrigger: false });
		vi.mocked(readFile).mockResolvedValue(
			JSON.stringify({ repositories: baseConfig.repositories }) as any,
		);

		const newConfig = await (manager as any).loadConfigSafely();

		expect(newConfig.prReviewTrigger).toBe(false);
	});
});
