import type { EdgeConfig, EdgeWorkerConfig } from "cyrus-core";
import { EdgeConfigSchema } from "cyrus-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { composeEdgeWorkerMock } = vi.hoisted(() => ({
	composeEdgeWorkerMock: vi.fn(),
}));

vi.mock("cyrus-edge-worker", () => ({
	composeEdgeWorker: composeEdgeWorkerMock,
}));

import type { ConfigService } from "./ConfigService.js";
import type { Logger } from "./Logger.js";
import { WorkerService } from "./WorkerService.js";

/**
 * Every serializable `EdgeConfigSchema` field, with a distinguishable value.
 *
 * The `it("covers every schema field")` case below asserts this fixture stays
 * exhaustive, so adding a field to the schema forces a decision here about
 * whether the CLI must forward it.
 */
const EDGE_CONFIG: EdgeConfig = {
	repositories: [],
	linearWorkspaces: {},
	linearWorkspaceSlug: "acme",
	ngrokAuthToken: "ngrok-token-from-config",
	stripeCustomerId: "cus_test",
	claudeDefaultModel: "sonnet",
	claudeDefaultFallbackModel: "haiku",
	claudeAutoCompactWindow: 120_000,
	claudeSessionKeepAliveMinutes: 30,
	claudeMaxWarmIdleSessions: 4,
	cursorDefaultModel: "cursor-default",
	cursorDefaultFallbackModel: "cursor-fallback",
	defaultRunner: "claude",
	defaultModel: "legacy-model",
	defaultFallbackModel: "legacy-fallback",
	global_setup_script: "./setup.sh",
	linearAllowedTools: ["Read"],
	defaultAllowedTools: ["Edit"],
	defaultDisallowedTools: ["Bash"],
	githubAllowedTools: ["Glob"],
	linearMcpConfigs: ["/tmp/linear-mcp.json"],
	githubMcpConfigs: ["/tmp/github-mcp.json"],
	issueUpdateTrigger: true,
	prReviewTrigger: false,
	userAccessControl: undefined,
	promptDefaults: undefined,
	sandbox: undefined,
};

/**
 * Fields `startEdgeWorker` deliberately supplies from its own parameters rather
 * than from the config file.
 */
const OVERRIDDEN_BY_RUNTIME = new Set(["repositories", "ngrokAuthToken"]);

const MODEL_ENV_VARS = [
	"CYRUS_CLAUDE_DEFAULT_MODEL",
	"CYRUS_DEFAULT_MODEL",
	"CYRUS_CLAUDE_DEFAULT_FALLBACK_MODEL",
	"CYRUS_DEFAULT_FALLBACK_MODEL",
	"CYRUS_CURSOR_DEFAULT_MODEL",
	"CYRUS_CURSOR_DEFAULT_FALLBACK_MODEL",
	"CYRUS_DEFAULT_RUNNER",
	"LINEAR_ALLOWED_TOOLS",
	"DISALLOWED_TOOLS",
];

async function startWorkerAndCaptureConfig(): Promise<EdgeWorkerConfig> {
	const edgeWorkerStub = {
		setConfigPath: vi.fn(),
		on: vi.fn(),
		start: vi.fn().mockResolvedValue(undefined),
	};
	composeEdgeWorkerMock.mockReturnValue(edgeWorkerStub);

	const configService = {
		load: () => EDGE_CONFIG,
		getConfigPath: () => "/tmp/cyrus/config.json",
	} as unknown as ConfigService;

	const logger = {
		info: vi.fn(),
		success: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	} as unknown as Logger;

	const worker = new WorkerService(
		configService,
		{} as never,
		"/tmp/cyrus",
		logger,
		"1.2.3",
	);

	await worker.startEdgeWorker({ repositories: [] });

	expect(composeEdgeWorkerMock).toHaveBeenCalledTimes(1);
	return composeEdgeWorkerMock.mock.calls[0]?.[0] as EdgeWorkerConfig;
}

describe("WorkerService config forwarding", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		for (const name of MODEL_ENV_VARS) vi.stubEnv(name, undefined);
	});

	it("covers every schema field in the fixture", () => {
		expect(Object.keys(EDGE_CONFIG).sort()).toEqual(
			Object.keys(EdgeConfigSchema.shape).sort(),
		);
	});

	// `EdgeWorkerConfig` is `EdgeConfig & EdgeWorkerRuntimeConfig`, so a field
	// that reaches config.json must reach the EdgeWorker. Hand-copying the
	// fields here previously dropped `claudeAutoCompactWindow` (auto-compaction
	// never fired; sessions grew to 218k tokens) and
	// `claudeSessionKeepAliveMinutes`, both silently.
	it("forwards every config-file field to the EdgeWorker", async () => {
		const config = await startWorkerAndCaptureConfig();

		for (const key of Object.keys(EdgeConfigSchema.shape)) {
			if (OVERRIDDEN_BY_RUNTIME.has(key)) continue;
			expect(
				config[key as keyof EdgeWorkerConfig],
				`EdgeConfig field "${key}" was dropped on the way to EdgeWorker`,
			).toEqual(EDGE_CONFIG[key as keyof EdgeConfig]);
		}
	});

	it("still supplies runtime-owned fields from its parameters", async () => {
		const config = await startWorkerAndCaptureConfig();

		expect(config.repositories).toEqual([]);
		expect(config.ngrokAuthToken).toBeUndefined();
		expect(config.cyrusHome).toBe("/tmp/cyrus");
		expect(config.version).toBe("1.2.3");
	});
});
