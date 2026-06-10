import type {
	EdgeConfig,
	EdgeWorkerConfig,
	RepositoryConfig,
} from "cyrus-core";
import type { GitService } from "cyrus-edge-worker";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigService } from "./ConfigService.js";
import type { Logger } from "./Logger.js";

const edgeWorkerInstances: Array<{
	config: EdgeWorkerConfig;
	setConfigPath: ReturnType<typeof vi.fn>;
	on: ReturnType<typeof vi.fn>;
	start: ReturnType<typeof vi.fn>;
}> = [];

vi.mock("cyrus-edge-worker", () => ({
	EdgeWorker: vi.fn().mockImplementation((config: EdgeWorkerConfig) => {
		const instance = {
			config,
			setConfigPath: vi.fn(),
			on: vi.fn(),
			start: vi.fn().mockResolvedValue(undefined),
		};
		edgeWorkerInstances.push(instance);
		return instance;
	}),
}));

vi.mock("cyrus-cloudflare-tunnel-client", () => ({
	getCyrusAppUrl: vi.fn(),
}));

vi.mock("cyrus-slack-event-transport", () => ({
	SlackEventTransport: vi.fn(),
}));

const { WorkerService } = await import("./WorkerService.js");

const repository: RepositoryConfig = {
	id: "repo-1",
	name: "Repo 1",
	repositoryPath: "/tmp/repo-1",
	baseBranch: "main",
};

describe("WorkerService", () => {
	beforeEach(() => {
		edgeWorkerInstances.length = 0;
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	function createWorkerService(edgeConfig: EdgeConfig) {
		const configService = {
			load: () => edgeConfig,
			getConfigPath: () => "/tmp/cyrus/config.json",
		} as unknown as ConfigService;
		const gitService = { createGitWorktree: vi.fn() } as unknown as GitService;
		const logger = {
			info: vi.fn(),
			success: vi.fn(),
			error: vi.fn(),
			warn: vi.fn(),
		} as unknown as Logger;

		return new WorkerService(
			configService,
			gitService,
			"/tmp/cyrus",
			logger,
			"test-version",
		);
	}

	async function startService(edgeConfig: EdgeConfig) {
		await createWorkerService(edgeConfig).startEdgeWorker({
			repositories: [repository],
			onOAuthCallback: vi.fn(),
		});

		expect(edgeWorkerInstances).toHaveLength(1);
		return edgeWorkerInstances[0].config;
	}

	it("forwards top-level OpenCode config overrides to EdgeWorker", async () => {
		const opencode = {
			config: {
				provider: {
					anthropic: { options: { baseURL: "https://opencode.test" } },
				},
			},
		};
		const config = await startService({ repositories: [], opencode });

		expect(config.opencode).toBe(opencode);
	});

	it("forwards OpenCode model config defaults to EdgeWorker", async () => {
		const config = await startService({
			repositories: [],
			opencodeDefaultModel: "anthropic/claude-sonnet-4.5",
			opencodeDefaultFallbackModel: "anthropic/claude-haiku-4.5",
			inferOpenCodeRunnerFromProviderModel: true,
		});

		expect(config.opencodeDefaultModel).toBe("anthropic/claude-sonnet-4.5");
		expect(config.opencodeDefaultFallbackModel).toBe(
			"anthropic/claude-haiku-4.5",
		);
		expect(config.inferOpenCodeRunnerFromProviderModel).toBe(true);
	});

	it("prefers OpenCode model environment defaults over config defaults", async () => {
		vi.stubEnv("CYRUS_OPENCODE_DEFAULT_MODEL", "openai/gpt-5.5");
		vi.stubEnv("CYRUS_OPENCODE_DEFAULT_FALLBACK_MODEL", "openai/gpt-5-mini");

		const config = await startService({
			repositories: [],
			opencodeDefaultModel: "anthropic/claude-sonnet-4.5",
			opencodeDefaultFallbackModel: "anthropic/claude-haiku-4.5",
		});

		expect(config.opencodeDefaultModel).toBe("openai/gpt-5.5");
		expect(config.opencodeDefaultFallbackModel).toBe("openai/gpt-5-mini");
	});

	it("prefers OpenCode provider/model inference environment default over config default", async () => {
		vi.stubEnv("CYRUS_INFER_OPENCODE_RUNNER_FROM_PROVIDER_MODEL", "true");

		const config = await startService({
			repositories: [],
			inferOpenCodeRunnerFromProviderModel: false,
		});

		expect(config.inferOpenCodeRunnerFromProviderModel).toBe(true);
	});
});
