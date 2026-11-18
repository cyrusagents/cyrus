import { EventEmitter } from "node:events";
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

describe("warm sessions with toolApprovalMode auto", () => {
	let fixture: string;
	const runners: ClaudeRunner[] = [];

	afterEach(() => {
		for (const runner of runners.splice(0)) runner.stop();
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
		vi.resetAllMocks();
		if (fixture) rmSync(fixture, { recursive: true, force: true });
	});

	function makeWorker(globalMode?: "auto" | "allowlist") {
		vi.spyOn(ClaudeRunner.prototype as any, "setupLogging").mockImplementation(
			() => {},
		);
		vi.stubEnv("CYRUS_ENABLE_WARM_SESSIONS", "1");
		vi.stubEnv("CYRUS_LOG_LEVEL", "ERROR");
		fixture = mkdtempSync(join(tmpdir(), "cyrus-warm-auto-"));
		const repo = { id: "repo", name: "test", linearWorkspaceId: "workspace" };
		const session = {
			id: "agent-session",
			claudeSessionId: "persisted-claude-session",
			workspace: { path: fixture },
			updatedAt: 1,
		};
		const logger = {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			withContext: vi.fn(),
		};
		logger.withContext.mockReturnValue(logger);
		const live = {
			config: {
				workingDirectory: fixture,
				cyrusHome: fixture,
				allowedTools: ["Read", "Bash"],
				disallowedTools: ["Write"],
				resumeSessionId: session.claudeSessionId,
				onAskUserQuestion: vi.fn(),
			} as ClaudeRunnerConfig,
		};
		const worker = Object.assign(Object.create(EdgeWorker.prototype), {
			config: globalMode ? { toolApprovalMode: globalMode } : {},
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
			buildAllowedTools: () => ["Read", "Bash"],
			buildDisallowedTools: () => ["Write"],
			skillsPluginResolver: {
				resolve: async () => [],
				discoverSkillNames: async () => [],
			},
			runnerConfigBuilder: {
				buildIssueConfig: () => ({
					config: { ...live.config },
					runnerType: "claude",
				}),
			},
		});
		const attach = () =>
			worker.buildAgentRunnerConfig(
				session,
				repo,
				session.id,
				undefined,
				["Read", "Bash"],
				[],
				["Write"],
				session.claudeSessionId,
				undefined,
				undefined,
				undefined,
				"workspace",
				{ repositoryId: repo.id, repoPaths: [fixture] },
			);
		return { worker, session, live, attach };
	}

	function fakeWarm() {
		return {
			query: vi.fn(() => (async function* () {})()),
			close: vi.fn(),
		} as unknown as WarmQuery & { close: ReturnType<typeof vi.fn> };
	}

	it("skips prewarming when global toolApprovalMode is auto", async () => {
		const { worker } = makeWorker("auto");
		await worker.warmupRecentSessions();
		expect(startup).not.toHaveBeenCalled();
		expect(worker.warmInstances.size).toBe(0);
	});

	it("keeps the legacy warm startup when the mode is allowlist", async () => {
		const { worker, session } = makeWorker("allowlist");
		const warm = fakeWarm();
		vi.mocked(startup).mockResolvedValue(warm);
		await worker.warmupRecentSessions();
		const options = vi.mocked(startup).mock.calls[0]![0].options!;
		expect(options.permissionMode).toBe("default");
		expect(options.allowedTools).toEqual(["Read", "Bash"]);
		expect(worker.warmInstances.get(session.id)).toBe(warm);
	});

	it("closes a warm startup that finishes after the config switched to auto", async () => {
		const { worker } = makeWorker();
		const warm = fakeWarm();
		vi.mocked(startup).mockImplementation(async () => {
			worker.config = { toolApprovalMode: "auto" };
			return warm;
		});
		await worker.warmupRecentSessions();
		expect(warm.close).toHaveBeenCalledOnce();
		expect(worker.warmInstances.size).toBe(0);
	});

	it("never lets an auto session adopt a warm instance; it runs the protected cold query", async () => {
		const { worker, session, live, attach } = makeWorker("auto");
		const warm = fakeWarm();
		worker.warmInstances.set(session.id, warm); // e.g. created before reload
		live.config = { ...live.config, toolApprovalMode: "auto" };
		vi.mocked(query).mockImplementation(
			() => (async function* () {})() as ReturnType<typeof query>,
		);

		const attached = await attach();
		expect(attached.config.warmSession).toBeUndefined();
		expect(warm.close).toHaveBeenCalledOnce();
		expect(worker.warmInstances.size).toBe(0);

		const runner = new ClaudeRunner(attached.config);
		runners.push(runner);
		await runner.start("Resume in auto");
		expect(warm.query).not.toHaveBeenCalled();
		const options = vi.mocked(query).mock.calls[0]![0].options!;
		expect(options.permissionMode).toBe("auto");
		expect(options.canUseTool).toEqual(expect.any(Function));
		expect(options.allowedTools ?? []).not.toContain("Bash");
		expect(options.disallowedTools).toEqual(expect.arrayContaining(["Write"]));
	});

	it("reload to auto closes warm instances; a reload that keeps the mode preserves them", async () => {
		const { worker, session } = makeWorker("allowlist");
		const warm = fakeWarm();
		worker.warmInstances.set(session.id, warm);
		const configManager = Object.assign(new EventEmitter(), {
			startConfigWatcher: vi.fn(),
			setConfig: vi.fn(),
		});
		Object.assign(worker, {
			configManager,
			updateLinearWorkspaceTokens: vi.fn(),
			removeDeletedRepositories: vi.fn(async () => {}),
			updateModifiedRepositories: vi.fn(async () => {}),
			addNewRepositories: vi.fn(async () => {}),
			applySandboxConfigChanges: vi.fn(async () => {}),
			userAccessControl: { setGlobalConfig: vi.fn() },
			runnerSelectionService: { setConfig: vi.fn() },
			toolPermissionResolver: { setConfig: vi.fn() },
			runnerSlots: { setLimit: vi.fn() },
		});
		worker.startConfigWatcher();
		const reload = async (newConfig: Record<string, unknown>) => {
			const [listener] = configManager.listeners("configChanged");
			await (listener as (c: unknown) => Promise<void>)({
				added: [],
				modified: [],
				removed: [],
				newConfig: { repositories: [], ...newConfig },
			});
		};

		await reload({ toolApprovalMode: "allowlist" });
		expect(warm.close).not.toHaveBeenCalled();
		expect(worker.warmInstances.get(session.id)).toBe(warm);

		await reload({ toolApprovalMode: "auto" });
		expect(warm.close).toHaveBeenCalledOnce();
		expect(worker.warmInstances.size).toBe(0);
	});
});

describe("issue-session toolApprovalMode resolution", () => {
	it.each([
		"linear",
		"github",
		"gitlab",
	] as const)("%s issue sessions resolve auto, prompt-scoped policies stay allowlist", async (platform) => {
		const buildIssueConfig = vi.fn(() => ({
			config: {},
			runnerType: "claude",
		}));
		const logger = { debug: vi.fn(), withContext: vi.fn() };
		logger.withContext.mockReturnValue(logger);
		const worker = Object.assign(Object.create(EdgeWorker.prototype), {
			config: { toolApprovalMode: "auto" },
			logger,
			skillsPluginResolver: {
				resolve: async () => [],
				discoverSkillNames: async () => [],
			},
			githubTokenStore: { getTokenForRepoUrl: () => undefined },
			runnerConfigBuilder: { buildIssueConfig },
		});
		const repo = { id: "repo", name: "test", repositoryPath: "/repo" };
		const session = { id: "s", workspace: { path: "/ws" } };
		const build = (promptScoped: boolean) =>
			worker.buildAgentRunnerConfig(
				session,
				repo,
				"s",
				undefined,
				["Read"],
				[],
				["Write"],
				undefined,
				undefined,
				undefined,
				undefined,
				"workspace",
				{ repositoryId: repo.id, repoPaths: ["/repo"] },
				platform,
				promptScoped,
			);
		await build(false);
		await build(true);
		const inputs = buildIssueConfig.mock.calls.map(
			(call) => (call as unknown as [Record<string, unknown>])[0],
		);
		expect(inputs.map((i) => i.toolApprovalMode)).toEqual([
			"auto",
			"allowlist",
		]);
		expect(inputs[0]?.disallowedTools).toEqual(["Write"]);
	});
});
