import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EdgeWorkerConfig, ILogger, RepositoryConfig } from "cyrus-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigManager } from "../src/ConfigManager.js";

const logger: ILogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
} as unknown as ILogger;

const repo: RepositoryConfig = {
	id: "repo-1",
	name: "Repo 1",
	repositoryPath: "/tmp/repo-1",
	baseBranch: "main",
};

describe("ConfigManager", () => {
	let tempDir: string | undefined;

	it("reloads and clears tool directories while network sandboxing is disabled", async () => {
		tempDir = await mkdtemp(join(tmpdir(), "cyrus-config-manager-"));
		const configPath = join(tempDir, "config.json");
		const manager = new ConfigManager(
			{ repositories: [repo] },
			logger,
			configPath,
			new Map([[repo.id, repo]]),
		);
		const onConfigChanged = vi.fn();
		manager.on("configChanged", onConfigChanged);
		const reloadable = manager as unknown as {
			handleConfigChange(): Promise<void>;
		};
		for (const directories of [["~/.tool-state"], []]) {
			const sandbox = {
				enabled: false,
				additionalWritableDirectories: directories,
			};
			await writeFile(
				configPath,
				JSON.stringify({ repositories: [repo], sandbox }),
			);
			await reloadable.handleConfigChange();
			const changes = onConfigChanged.mock.lastCall?.[0];
			expect(changes.newConfig.sandbox).toEqual(sandbox);
			manager.setConfig(changes.newConfig);
		}
		expect(onConfigChanged).toHaveBeenCalledTimes(2);
	});

	afterEach(async () => {
		if (tempDir) {
			await rm(tempDir, { recursive: true, force: true });
			tempDir = undefined;
		}
	});

	it("reloads top-level OpenCode config and emits it as a global config change", async () => {
		tempDir = await mkdtemp(join(tmpdir(), "cyrus-config-manager-"));
		const configPath = join(tempDir, "config.json");
		const opencode = {
			config: {
				provider: {
					anthropic: { options: { baseURL: "https://opencode.test" } },
				},
			},
		};

		const initialConfig: EdgeWorkerConfig = {
			repositories: [repo],
			opencode: { config: { model: "opencode" } },
		};
		const manager = new ConfigManager(
			initialConfig,
			logger,
			configPath,
			new Map([[repo.id, repo]]),
		);
		const onConfigChanged = vi.fn();
		manager.on("configChanged", onConfigChanged);

		await writeFile(
			configPath,
			JSON.stringify({ repositories: [repo], opencode }),
		);
		await (manager as any).handleConfigChange();

		expect(onConfigChanged).toHaveBeenCalledOnce();
		expect(onConfigChanged.mock.calls[0][0].newConfig.opencode).toEqual(
			opencode,
		);
	});

	it("reloads strictMcpConfig=false and emits it as a global config change", async () => {
		tempDir = await mkdtemp(join(tmpdir(), "cyrus-config-manager-"));
		const configPath = join(tempDir, "config.json");
		const initialConfig: EdgeWorkerConfig = {
			repositories: [repo],
			strictMcpConfig: true,
		};
		const manager = new ConfigManager(
			initialConfig,
			logger,
			configPath,
			new Map([[repo.id, repo]]),
		);
		const onConfigChanged = vi.fn();
		manager.on("configChanged", onConfigChanged);

		await writeFile(
			configPath,
			JSON.stringify({ repositories: [repo], strictMcpConfig: false }),
		);
		await (manager as any).handleConfigChange();

		expect(onConfigChanged).toHaveBeenCalledOnce();
		expect(onConfigChanged.mock.calls[0][0].newConfig.strictMcpConfig).toBe(
			false,
		);
	});
});
