import { readFile } from "node:fs/promises";
import type { EdgeWorkerConfig, ILogger } from "cyrus-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigManager } from "../src/ConfigManager.js";

vi.mock("node:fs/promises");

/**
 * Tests for CYPACK-1273: ensure the `prReviewTrigger` flag participates in
 * the config hot-reload pipeline — both the merge in `loadConfigSafely()` and
 * the global-change detection in `detectGlobalConfigChanges()`. Without these,
 * a `prReviewTrigger` change written to config.json while Cyrus is running
 * would be silently dropped (see CLAUDE.md note #9).
 */
describe("ConfigManager - prReviewTrigger hot-reload (CYPACK-1273)", () => {
	let logger: ILogger;

	const baseConfig: EdgeWorkerConfig = {
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

	function makeManager(config: EdgeWorkerConfig): ConfigManager {
		return new ConfigManager(
			config,
			logger,
			"/tmp/cyrus-home/config.json",
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
	it("hot-reloads and revokes GitHub app policies when removed", async () => {
		const policy = [
			{
				installationId: "123",
				organization: "Grain",
				appIds: [42],
				includeSuggestions: true,
			},
		];
		const manager = makeManager({
			...baseConfig,
			githubReviewAppPolicies: policy,
		});
		vi.mocked(readFile).mockResolvedValue(
			JSON.stringify({ repositories: baseConfig.repositories }) as any,
		);
		expect(
			(await (manager as any).loadConfigSafely()).githubReviewAppPolicies,
		).toEqual([]);
		expect(
			(manager as any).detectGlobalConfigChanges({
				...baseConfig,
				githubReviewAppPolicies: [],
			}),
		).toBe(true);
		vi.mocked(readFile).mockResolvedValue(
			JSON.stringify({
				repositories: baseConfig.repositories,
				githubReviewAppPolicies: policy,
			}) as any,
		);
		expect(
			(await (manager as any).loadConfigSafely()).githubReviewAppPolicies,
		).toEqual(policy);
	});
});
