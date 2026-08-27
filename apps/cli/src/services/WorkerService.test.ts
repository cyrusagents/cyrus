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

const mocks = vi.hoisted(() => ({
	mockSharedApplicationServer: vi.fn(),
	mockConfigUpdater: vi.fn(),
	mockSlackEventTransport: vi.fn(),
}));

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
	SharedApplicationServer: mocks.mockSharedApplicationServer,
}));

vi.mock("cyrus-config-updater", () => ({
	ConfigUpdater: mocks.mockConfigUpdater,
}));

vi.mock("cyrus-cloudflare-tunnel-client", () => ({
	getCyrusAppUrl: vi.fn(() => "https://app.example.com"),
}));

vi.mock("cyrus-slack-event-transport", () => ({
	SlackEventTransport: mocks.mockSlackEventTransport,
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
		mocks.mockSharedApplicationServer.mockReset();
		mocks.mockConfigUpdater.mockReset();
		mocks.mockSlackEventTransport.mockReset();

		mocks.mockSharedApplicationServer.mockImplementation(function () {
			return {
				initializeFastify: vi.fn(),
				getFastifyInstance: vi.fn().mockReturnValue({}),
				start: vi.fn().mockResolvedValue(undefined),
				stop: vi.fn().mockResolvedValue(undefined),
			};
		});
		mocks.mockConfigUpdater.mockImplementation(function () {
			return { register: vi.fn() };
		});
		mocks.mockSlackEventTransport.mockImplementation(function () {
			return { register: vi.fn() };
		});

		// The bind-address tests read these, so they must not inherit the shell.
		for (const key of [
			"CYRUS_HOST_EXTERNAL",
			"CYRUS_SERVER_HOST",
			"CYRUS_SERVER_PORT",
			"CLOUDFLARE_TOKEN",
			"SLACK_SIGNING_SECRET",
		]) {
			vi.stubEnv(key, undefined as unknown as string);
		}
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
			raw: vi.fn(),
			divider: vi.fn(),
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
			codexSandboxMode: "read-only",
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
			zulipMcpConfigs: ["~/zulip.json"],
			linearMcpConfigs: ["~/linear.json"],
			githubMcpConfigs: ["~/github.json"],
			strictMcpConfig: false,
			issueUpdateTrigger: false,
			slackThreadFollowing: false,
			prReviewTrigger: false,
			userAccessControl: { allowedUsers: ["usr_1"] },
			promptDefaults: { debugger: { allowedTools: ["Read"] } },
			sandbox: { enabled: false },
			maxConcurrentSessions: 3,
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

	describe("bind address", () => {
		let service: WorkerService;

		beforeEach(() => {
			service = createWorkerService({ repositories: [] });
		});

		/** Host passed positionally as the 2nd arg of `new SharedApplicationServer(port, host)`. */
		const preWorkerServerHost = (): string =>
			mocks.mockSharedApplicationServer.mock.calls[0][1];

		/** Host taken from the `EdgeWorkerConfig` handed to `new EdgeWorker(config)`. */
		const edgeWorkerHost = (): string | undefined =>
			edgeWorkerInstances[0]?.config.serverHost;

		describe("setup-waiting / idle server", () => {
			it("falls back to localhost when neither variable is set", async () => {
				await service.startSetupWaitingMode();

				expect(mocks.mockSharedApplicationServer).toHaveBeenCalledWith(
					3456,
					"localhost",
				);
			});

			it("falls back to 0.0.0.0 when CYRUS_HOST_EXTERNAL is true", async () => {
				vi.stubEnv("CYRUS_HOST_EXTERNAL", "true");

				await service.startIdleMode();

				expect(preWorkerServerHost()).toBe("0.0.0.0");
			});

			it("uses CYRUS_SERVER_HOST when set", async () => {
				vi.stubEnv("CYRUS_SERVER_HOST", "127.0.0.1");

				await service.startSetupWaitingMode();

				expect(preWorkerServerHost()).toBe("127.0.0.1");
			});

			it("lets CYRUS_SERVER_HOST override CYRUS_HOST_EXTERNAL", async () => {
				vi.stubEnv("CYRUS_HOST_EXTERNAL", "true");
				vi.stubEnv("CYRUS_SERVER_HOST", "127.0.0.1");

				await service.startIdleMode();

				expect(preWorkerServerHost()).toBe("127.0.0.1");
			});
		});

		describe("edge worker", () => {
			const start = () => service.startEdgeWorker({ repositories: [] });

			it("falls back to localhost when neither variable is set", async () => {
				await start();

				expect(edgeWorkerHost()).toBe("localhost");
			});

			it("falls back to 0.0.0.0 when CYRUS_HOST_EXTERNAL is true", async () => {
				vi.stubEnv("CYRUS_HOST_EXTERNAL", "true");

				await start();

				expect(edgeWorkerHost()).toBe("0.0.0.0");
			});

			it("uses CYRUS_SERVER_HOST when set", async () => {
				vi.stubEnv("CYRUS_SERVER_HOST", "127.0.0.1");

				await start();

				expect(edgeWorkerHost()).toBe("127.0.0.1");
			});

			it("lets CYRUS_SERVER_HOST override CYRUS_HOST_EXTERNAL", async () => {
				// The tunnelled self-host case: bind loopback while keeping
				// CYRUS_HOST_EXTERNAL=true for direct webhook verification.
				vi.stubEnv("CYRUS_HOST_EXTERNAL", "true");
				vi.stubEnv("CYRUS_SERVER_HOST", "127.0.0.1");

				await start();

				expect(edgeWorkerHost()).toBe("127.0.0.1");
			});
		});

		describe("non-loopback rejection", () => {
			it("rejects an override that binds non-loopback outside external mode", async () => {
				vi.stubEnv("CYRUS_SERVER_HOST", "0.0.0.0");

				await expect(
					service.startEdgeWorker({ repositories: [] }),
				).rejects.toThrow("CYRUS_SERVER_HOST=0.0.0.0");
				// Startup fails before the listener is opened.
				expect(edgeWorkerInstances).toHaveLength(0);
				expect(mocks.mockSharedApplicationServer).not.toHaveBeenCalled();
			});

			it("rejects from the setup-waiting server too", async () => {
				vi.stubEnv("CYRUS_SERVER_HOST", "192.168.1.10");

				await expect(service.startSetupWaitingMode()).rejects.toThrow(
					"CYRUS_SERVER_HOST=192.168.1.10",
				);
				expect(mocks.mockSharedApplicationServer).not.toHaveBeenCalled();
			});

			it("rejects a hostname that merely looks like loopback", async () => {
				vi.stubEnv("CYRUS_SERVER_HOST", "127.example.com");

				await expect(service.startSetupWaitingMode()).rejects.toThrow(
					"CYRUS_SERVER_HOST=127.example.com",
				);
				expect(mocks.mockSharedApplicationServer).not.toHaveBeenCalled();
			});

			it("does not reject for a loopback override", async () => {
				vi.stubEnv("CYRUS_SERVER_HOST", "127.0.0.1");

				await service.startSetupWaitingMode();

				expect(mocks.mockSharedApplicationServer).toHaveBeenCalledWith(
					3456,
					"127.0.0.1",
				);
			});

			it("does not reject when CYRUS_HOST_EXTERNAL makes the public bind intentional", async () => {
				vi.stubEnv("CYRUS_HOST_EXTERNAL", "true");

				await service.startEdgeWorker({ repositories: [] });

				expect(edgeWorkerInstances).toHaveLength(1);
			});
		});

		it("does not change webhook verification mode", async () => {
			// CYRUS_SERVER_HOST moves the bind address only. Slack direct
			// verification stays gated on CYRUS_HOST_EXTERNAL alone.
			vi.stubEnv("CYRUS_SERVER_HOST", "127.0.0.1");
			vi.stubEnv("SLACK_SIGNING_SECRET", "slack-secret");

			await service.startSetupWaitingMode();
			expect(mocks.mockSlackEventTransport).not.toHaveBeenCalled();

			await service.stopWaitingServer();
			vi.stubEnv("CYRUS_HOST_EXTERNAL", "true");

			await service.startSetupWaitingMode();
			expect(mocks.mockSlackEventTransport).toHaveBeenCalledWith(
				expect.objectContaining({
					verificationMode: "direct",
					secret: "slack-secret",
				}),
			);
		});
	});
});
