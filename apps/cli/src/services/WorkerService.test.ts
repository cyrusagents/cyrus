import {
	type EdgeConfig,
	EdgeConfigSchema,
	type EdgeWorkerConfig,
	type RepositoryConfig,
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
	EdgeWorker: vi.fn().mockImplementation(function (config: EdgeWorkerConfig) {
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

	it("forwards every EdgeConfig field into the EdgeWorker config (no silent drops)", async () => {
		// One distinctive value per top-level EdgeConfigSchema key. The
		// completeness assertion below forces this fixture to grow whenever a
		// field is added to the schema, and the per-key equality loop then
		// catches CYPACK-1478-style silent drops in startEdgeWorker.
		const fullEdgeConfig = EdgeConfigSchema.parse({
			repositories: [{ ...repository, workspaceBaseDir: "/tmp/workspaces" }],
			linearWorkspaces: { "ws-1": { linearToken: "lin_token" } },
			linearWorkspaceSlug: "legacy-slug",
			ngrokAuthToken: "ngrok-token",
			stripeCustomerId: "cus_123",
			claudeDefaultModel: "opus",
			claudeDefaultFallbackModel: "sonnet",
			geminiDefaultModel: "gemini-2.5-pro",
			codexDefaultModel: "gpt-5.3-codex",
			cursorDefaultModel: "composer-2",
			cursorDefaultFallbackModel: "gpt-5.4",
			opencodeDefaultModel: "anthropic/claude-sonnet-4.5",
			opencodeDefaultFallbackModel: "anthropic/claude-haiku-4.5",
			inferOpenCodeRunnerFromProviderModel: true,
			opencode: { config: { theme: "dark" } },
			defaultRunner: "claude",
			defaultModel: "legacy-model",
			defaultFallbackModel: "legacy-fallback",
			global_setup_script: "~/setup.sh",
			linearAllowedTools: ["Read"],
			defaultAllowedTools: ["Edit"],
			defaultDisallowedTools: ["WebSearch"],
			slackAllowedTools: ["Read"],
			githubAllowedTools: ["Bash"],
			slackMcpConfigs: ["~/slack.json"],
			linearMcpConfigs: ["~/linear.json"],
			githubMcpConfigs: ["~/github.json"],
			strictMcpConfig: false,
			issueUpdateTrigger: false,
			slackThreadFollowing: false,
			prReviewTrigger: false,
			singleSessionPerIssue: true,
			userAccessControl: { allowedUsers: ["usr_1"] },
			promptDefaults: { debugger: { allowedTools: ["Read"] } },
			sandbox: { enabled: false },
		});

		// Fixture-completeness tripwire: adding a field to EdgeConfigSchema
		// fails here until the fixture covers it, which in turn makes the
		// forwarding loop below verify the new field isn't dropped.
		expect(Object.keys(fullEdgeConfig).sort()).toEqual(
			Object.keys(EdgeConfigSchema.shape).sort(),
		);

		const config = await startService(fullEdgeConfig);

		for (const [key, value] of Object.entries(fullEdgeConfig)) {
			// These two are intentionally overridden by startEdgeWorker params.
			if (key === "repositories" || key === "ngrokAuthToken") continue;
			expect(
				config[key as keyof EdgeConfig],
				`EdgeConfig field "${key}" was dropped by startEdgeWorker`,
			).toEqual(value);
		}
	});

	it("forwards strictMcpConfig from the config file to EdgeWorker", async () => {
		const config = await startService({
			repositories: [],
			strictMcpConfig: false,
		});

		expect(config.strictMcpConfig).toBe(false);
	});

	it("leaves strictMcpConfig undefined when not set in the config file", async () => {
		const config = await startService({ repositories: [] });

		expect(config.strictMcpConfig).toBeUndefined();
	});

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
