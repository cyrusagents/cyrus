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
	it("reloads the Codex mode and restores the default when the field is removed", async () => {
		const dir = await mkdtemp(join(tmpdir(), "cyrus-codex-mode-"));
		const path = join(dir, "config.json");
		const manager = new ConfigManager(
			{ repositories: [repo] },
			logger,
			path,
			new Map([[repo.id, repo]]),
		);
		const changed = vi.fn();
		manager.on("configChanged", (event) => {
			changed(event);
			manager.setConfig(event.newConfig);
		});
		try {
			for (const mode of ["danger-full-access", "read-only", undefined]) {
				await writeFile(
					path,
					JSON.stringify({ repositories: [repo], codexSandboxMode: mode }),
				);
				await (manager as any).handleConfigChange();
				expect(changed.mock.lastCall?.[0].newConfig.codexSandboxMode).toBe(
					mode,
				);
			}
			expect(changed).toHaveBeenCalledTimes(3);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("reloads toolApprovalMode and restores the default when removed", async () => {
		const dir = await mkdtemp(join(tmpdir(), "cyrus-tool-approval-"));
		const path = join(dir, "config.json");
		const manager = new ConfigManager(
			{ repositories: [repo] },
			logger,
			path,
			new Map([[repo.id, repo]]),
		);
		const changed = vi.fn();
		manager.on("configChanged", (event) => {
			changed(event);
			manager.setConfig(event.newConfig);
		});
		try {
			for (const mode of ["auto", "allowlist", undefined]) {
				await writeFile(
					path,
					JSON.stringify({ repositories: [repo], toolApprovalMode: mode }),
				);
				await (manager as any).handleConfigChange();
				expect(changed.mock.lastCall?.[0].newConfig.toolApprovalMode).toBe(
					mode,
				);
			}
			expect(changed).toHaveBeenCalledTimes(3);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	let tempDir: string | undefined;

	afterEach(async () => {
		if (tempDir) {
			await rm(tempDir, { recursive: true, force: true });
			tempDir = undefined;
		}
	});

	it("reloads Slack allowlists and clears them when switching back to blocks", async () => {
		const dir = await mkdtemp(join(tmpdir(), "cyrus-slack-allowlist-"));
		const path = join(dir, "config.json");
		const manager = new ConfigManager(
			{ repositories: [repo] },
			logger,
			path,
			new Map([[repo.id, repo]]),
		);
		const changed = vi.fn();
		manager.on("configChanged", (event) => {
			changed(event);
			manager.setConfig(event.newConfig);
		});
		const allowMode = {
			slackAllowedChannelIds: ["C1"],
			userAccessControl: {
				allowedUsers: [{ id: "*" }, { slackId: "U1" }],
			},
		};
		const blockMode = {
			slackBlockedChannelIds: ["C9"],
			userAccessControl: { blockedUsers: [{ slackId: "U9" }] },
		};
		try {
			for (const mode of [allowMode, blockMode]) {
				await writeFile(
					path,
					JSON.stringify({ repositories: [repo], ...mode }),
				);
				await (manager as any).handleConfigChange();
				const config = changed.mock.lastCall?.[0].newConfig;
				expect(config.slackAllowedChannelIds).toEqual(
					mode.slackAllowedChannelIds,
				);
				expect(config.slackBlockedChannelIds).toEqual(
					mode.slackBlockedChannelIds,
				);
				expect(config.userAccessControl).toEqual(mode.userAccessControl);
			}
			expect(changed).toHaveBeenCalledTimes(2);
		} finally {
			await rm(dir, { recursive: true, force: true });
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
