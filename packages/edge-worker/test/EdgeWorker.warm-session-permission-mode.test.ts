import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Options,
	query,
	startup,
	type WarmQuery,
} from "@anthropic-ai/claude-agent-sdk";
import { ClaudeRunner, type ClaudeRunnerConfig } from "cyrus-claude-runner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EdgeWorker } from "../src/EdgeWorker.js";

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => ({
	...(await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>()),
	startup: vi.fn(),
	query: vi.fn(),
}));

// This is an option-propagation contract at the SDK boundary, not a claim
// about SDK permission enforcement. Both entry points are mocked: no provider
// request is needed to detect an omitted permissionMode.
describe("warm-session manual permission policy", () => {
	let fixture: string;
	const runners: ClaudeRunner[] = [];

	afterEach(() => {
		for (const runner of runners.splice(0)) runner.stop();
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
		vi.resetAllMocks();
		if (fixture) rmSync(fixture, { recursive: true, force: true });
	});

	it.each(
		["auto", "acceptEdits"].flatMap((defaultMode) =>
			["settings.json", "settings.local.json"].map((settingsFile) => ({
				defaultMode,
				settingsFile,
			})),
		),
	)("supplies default at warm startup and cold query with $defaultMode in $settingsFile", async ({
		defaultMode,
		settingsFile,
	}) => {
		// Logging is unrelated to this SDK boundary contract.
		vi.spyOn(ClaudeRunner.prototype as any, "setupLogging").mockImplementation(
			() => {},
		);
		fixture = mkdtempSync(join(tmpdir(), "cyrus-warm-permissions-"));
		const settingsDir = join(fixture, ".claude");
		mkdirSync(settingsDir);
		const settingsPath = join(settingsDir, settingsFile);
		writeFileSync(
			settingsPath,
			JSON.stringify({ permissions: { defaultMode } }),
		);
		vi.stubEnv("CYRUS_ENABLE_WARM_SESSIONS", "1");
		vi.stubEnv("CYRUS_LOG_LEVEL", "ERROR");

		const loadedModes: string[] = [];
		const captureSettings = (options: Options) => {
			expect(options.cwd).toBe(fixture);
			expect(options.settingSources).toEqual(["user", "project", "local"]);
			// Model loading project/local settings at each mocked SDK entry.
			const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
			loadedModes.push(settings.permissions.defaultMode);
		};
		const warmQuery = vi.fn(() => (async function* () {})());
		const warm = { query: warmQuery, close: vi.fn() } as unknown as WarmQuery;
		vi.mocked(startup).mockImplementation(async ({ options }) => {
			captureSettings(options!);
			return warm;
		});
		vi.mocked(query).mockImplementation(({ options }) => {
			captureSettings(options!);
			return (async function* () {})() as ReturnType<typeof query>;
		});

		const repo = { id: "repo", name: "test", linearWorkspaceId: "workspace" };
		const session = {
			id: "agent-session",
			claudeSessionId: "persisted-claude-session",
			workspace: { path: fixture },
			updatedAt: 1,
		};
		const config: ClaudeRunnerConfig = {
			workingDirectory: fixture,
			cyrusHome: fixture,
			allowedTools: ["Read"],
			disallowedTools: ["Write"],
			resumeSessionId: session.claudeSessionId,
		};
		const logger = { debug: vi.fn(), info: vi.fn(), withContext: vi.fn() };
		logger.withContext.mockReturnValue(logger);
		// Isolate warmup/attachment from unrelated webhook and server setup,
		// but execute the real EdgeWorker methods and real ClaudeRunner.start.
		const worker = Object.assign(Object.create(EdgeWorker.prototype), {
			config: {},
			cyrusHome: fixture,
			logger,
			agentSessionManager: { getAllSessions: () => [session] },
			sessionRepositories: new Map([[session.id, repo.id]]),
			repositories: new Map([[repo.id, repo]]),
			warmInstances: new Map(),
			mcpConfigService: {
				buildMcpConfig: () => ({}),
				buildMergedMcpConfigPath: vi.fn(),
			},
			buildAllowedTools: () => config.allowedTools,
			buildDisallowedTools: () => config.disallowedTools,
			skillsPluginResolver: {
				resolve: async () => [],
				discoverSkillNames: async () => [],
			},
			runnerConfigBuilder: {
				buildIssueConfig: () => ({
					config: { ...config },
					runnerType: "claude",
				}),
			},
		});

		await worker.warmupRecentSessions();
		expect(startup).toHaveBeenCalledTimes(1);
		const startupOptions = vi.mocked(startup).mock.calls[0]![0].options!;
		expect(startupOptions.permissionMode).toBe("default");
		expect(startupOptions.resume).toBe(session.claudeSessionId);
		expect(startupOptions.allowedTools).toEqual(["Read"]);
		expect(startupOptions.disallowedTools).toEqual(["Write"]);
		expect(worker.warmInstances.get(session.id)).toBe(warm);

		const attached = await worker.buildAgentRunnerConfig(
			session,
			repo,
			session.id,
			undefined,
			["Read"],
			[],
			["Write"],
			session.claudeSessionId,
			undefined,
			undefined,
			undefined,
			"workspace",
			{ repositoryId: repo.id, repoPaths: [fixture] },
		);
		expect(attached.config.warmSession).toBe(warm);
		expect(worker.warmInstances.has(session.id)).toBe(false);
		const warmRunner = new ClaudeRunner(attached.config);
		runners.push(warmRunner);
		await warmRunner.start("Resume warm session");
		expect(warmQuery).toHaveBeenCalledExactlyOnceWith("Resume warm session");
		expect(query).not.toHaveBeenCalled();
		expect(warmRunner.isRunning()).toBe(false);

		const coldRunner = new ClaudeRunner(config);
		runners.push(coldRunner);
		await coldRunner.start("Resume cold session");
		expect(query).toHaveBeenCalledTimes(1);
		const coldCall = vi.mocked(query).mock.calls[0]![0];
		expect(coldCall.prompt).toBe("Resume cold session");
		expect(coldCall.options?.permissionMode).toBe("default");
		expect(coldCall.options?.resume).toBe(session.claudeSessionId);
		expect(coldRunner.isRunning()).toBe(false);
		expect(loadedModes).toEqual([defaultMode, defaultMode]);
	});
});
