import { join } from "node:path";
import type { ILogger, RunnerType } from "cyrus-core";
import { describe, expect, it } from "vitest";
import {
	type IChatToolResolver,
	type IMcpConfigProvider,
	type IRunnerSelector,
	RunnerConfigBuilder,
} from "../src/RunnerConfigBuilder.js";

const silentLogger: ILogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
} as unknown as ILogger;

function makeBuilder(): RunnerConfigBuilder {
	return makeChatBuilder("claude");
}

function makeChatBuilder(defaultRunner: RunnerType): RunnerConfigBuilder {
	const chatToolResolver: IChatToolResolver = {
		buildChatAllowedTools: () => ["Read(**)"],
	};
	const mcpConfigProvider: IMcpConfigProvider = {
		buildMcpConfig: () => ({}),
		buildMergedMcpConfigPath: () => undefined,
	};
	const runnerSelector: IRunnerSelector = {
		determineRunnerSelection: () => ({ runnerType: "claude" as const }),
		getDefaultRunner: () => defaultRunner,
		getDefaultModelForRunner: () => "",
		getDefaultFallbackModelForRunner: () => "",
	};
	return new RunnerConfigBuilder(
		chatToolResolver,
		mcpConfigProvider,
		runnerSelector,
	);
}

function makeIssueBuilder(
	runnerType: "claude" | "opencode",
): RunnerConfigBuilder {
	const chatToolResolver: IChatToolResolver = {
		buildChatAllowedTools: () => ["Read(**)"],
	};
	const mcpConfigProvider: IMcpConfigProvider = {
		buildMcpConfig: () => ({}),
		buildMergedMcpConfigPath: () => undefined,
	};
	const runnerSelector: IRunnerSelector = {
		determineRunnerSelection: () => ({ runnerType }),
		getDefaultRunner: () => runnerType,
		getDefaultModelForRunner: () => "",
		getDefaultFallbackModelForRunner: () => "",
	};
	return new RunnerConfigBuilder(
		chatToolResolver,
		mcpConfigProvider,
		runnerSelector,
	);
}

describe("RunnerConfigBuilder.buildChatConfig", () => {
	it("includes autoMemoryDirectory in allowedDirectories so the session can read existing memory files (CYPACK-1197)", () => {
		const builder = makeBuilder();
		const cyrusHome = "/tmp/cyrus-home-test";
		const workspacePath = join(cyrusHome, "slack-workspaces", "thread-x");
		const repositoryPaths = ["/repo/one", "/repo/two"];

		const config = builder.buildChatConfig({
			workspacePath,
			workspaceName: "slack-thread-x",
			systemPrompt: "test",
			sessionId: "sess-1",
			cyrusHome,
			platformName: "slack",
			repositoryPaths,
			logger: silentLogger,
			onMessage: () => {},
			onError: () => {},
		});

		const expectedAutoMemoryDir = join(cyrusHome, "slack-memory");
		expect(config.autoMemoryDirectory).toBe(expectedAutoMemoryDir);
		expect(config.allowedDirectories).toEqual([
			workspacePath,
			expectedAutoMemoryDir,
			...repositoryPaths,
		]);
	});

	it("passes managed skill plugins and scoped skill names to chat runner configs", () => {
		const builder = makeBuilder();
		const plugins = [{ type: "local" as const, path: "/cyrus/user-skills" }];

		const config = builder.buildChatConfig({
			workspacePath: "/tmp/slack-workspace",
			workspaceName: "slack-thread-x",
			systemPrompt: "test",
			sessionId: "sess-1",
			cyrusHome: "/tmp/cyrus-home-test",
			platformName: "slack",
			plugins,
			skills: ["agent-browser", "test-user-skills"],
			logger: silentLogger,
			onMessage: () => {},
			onError: () => {},
		});

		expect(config.plugins).toEqual(plugins);
		expect(config.skills).toEqual(["agent-browser", "test-user-skills"]);
	});

	it("passes OpenCode config overrides only when chat default runner is OpenCode", () => {
		const globalConfig = {
			provider: { anthropic: { options: { baseURL: "https://global.test" } } },
		};
		const repositoryConfig = {
			model: "anthropic/claude-sonnet-4.5",
		};

		for (const defaultRunner of ["opencode", "claude"] as const) {
			const builder = makeChatBuilder(defaultRunner);
			const config = builder.buildChatConfig({
				workspacePath: "/tmp/chat-workspace",
				workspaceName: "slack-thread-x",
				systemPrompt: "test",
				sessionId: "sess-1",
				cyrusHome: "/tmp/cyrus-home-test",
				platformName: "slack",
				repository: {
					id: "repo-1",
					path: "/tmp/repo",
					opencode: { config: repositoryConfig, stateScope: "repository" },
				} as any,
				opencodeGlobalConfig: globalConfig,
				opencodeGlobalStateScope: "shared",
				logger: silentLogger,
				onMessage: () => {},
				onError: () => {},
			});

			if (defaultRunner === "opencode") {
				expect(config.opencodeGlobalConfig).toBe(globalConfig);
				expect(config.opencodeRepositoryConfig).toBe(repositoryConfig);
				expect(config.opencodeStateScope).toBe("repository");
				expect(config.opencodeStateKey).toBe("repo-1");
			} else {
				expect(config.opencodeGlobalConfig).toBeUndefined();
				expect(config.opencodeRepositoryConfig).toBeUndefined();
				expect(config.opencodeStateScope).toBeUndefined();
				expect(config.opencodeStateKey).toBeUndefined();
			}
		}
	});
});

describe("RunnerConfigBuilder.buildIssueConfig", () => {
	it("does not pass Claude SDK skills plugins to OpenCode issue sessions", () => {
		const builder = makeIssueBuilder("opencode");
		const plugins = [{ type: "local", path: "/tmp/cyrus-skills-plugin" }];

		const { config, runnerType } = builder.buildIssueConfig({
			session: {
				issueId: "issue-1",
				workspace: { path: "/tmp/worktree" },
				issue: { identifier: "NG-68" },
			} as any,
			repository: {
				id: "repo-1",
				path: "/tmp/repo",
			} as any,
			sessionId: "session-1",
			systemPrompt: "system",
			allowedTools: ["Skill", "Read(**)"],
			allowedDirectories: ["/tmp/worktree"],
			disallowedTools: [],
			labels: ["opencode"],
			cyrusHome: "/tmp/cyrus",
			logger: silentLogger,
			onMessage: () => {},
			onError: () => {},
			requireLinearWorkspaceId: () => "workspace-1",
			plugins: plugins as any,
			skills: ["debug"],
		});

		expect(runnerType).toBe("opencode");
		expect((config as any).plugins).toBeUndefined();
		expect((config as any).skills).toBeUndefined();
	});

	it("passes scoped skills plugins to Claude issue sessions", () => {
		const builder = makeIssueBuilder("claude");
		const plugins = [{ type: "local", path: "/tmp/cyrus-skills-plugin" }];

		const { config, runnerType } = builder.buildIssueConfig({
			session: {
				issueId: "issue-1",
				workspace: { path: "/tmp/worktree" },
				issue: { identifier: "NG-68" },
			} as any,
			repository: {
				id: "repo-1",
				path: "/tmp/repo",
			} as any,
			sessionId: "session-1",
			systemPrompt: "system",
			allowedTools: ["Skill", "Read(**)"],
			allowedDirectories: ["/tmp/worktree"],
			disallowedTools: [],
			labels: ["claude"],
			cyrusHome: "/tmp/cyrus",
			logger: silentLogger,
			onMessage: () => {},
			onError: () => {},
			requireLinearWorkspaceId: () => "workspace-1",
			plugins: plugins as any,
			skills: ["debug"],
		});

		expect(runnerType).toBe("claude");
		expect((config as any).plugins).toBe(plugins);
		expect((config as any).skills).toEqual(["debug"]);
	});

	it("passes OpenCode config overrides only to OpenCode issue sessions", () => {
		const globalConfig = {
			provider: { anthropic: { options: { baseURL: "https://global.test" } } },
		};
		const repositoryConfig = {
			model: "anthropic/claude-sonnet-4.5",
		};

		for (const selectedRunner of ["opencode", "claude"] as const) {
			const builder = makeIssueBuilder(selectedRunner);
			const { config, runnerType } = builder.buildIssueConfig({
				session: {
					issueId: "issue-1",
					workspace: { path: "/tmp/worktree" },
					issue: { identifier: "NG-71" },
				} as any,
				repository: {
					id: "repo-1",
					path: "/tmp/repo",
					opencode: { config: repositoryConfig, stateScope: "repository" },
				} as any,
				sessionId: "session-1",
				systemPrompt: "system",
				allowedTools: ["Read(**)"],
				allowedDirectories: ["/tmp/worktree"],
				disallowedTools: [],
				labels: [selectedRunner],
				cyrusHome: "/tmp/cyrus",
				logger: silentLogger,
				onMessage: () => {},
				onError: () => {},
				requireLinearWorkspaceId: () => "workspace-1",
				opencodeGlobalConfig: globalConfig,
				opencodeGlobalStateScope: "shared",
			});

			expect(runnerType).toBe(selectedRunner);
			if (selectedRunner === "opencode") {
				expect(config.opencodeGlobalConfig).toBe(globalConfig);
				expect(config.opencodeRepositoryConfig).toBe(repositoryConfig);
				expect(config.opencodeStateScope).toBe("repository");
				expect(config.opencodeStateKey).toBe("repo-1");
			} else {
				expect(config.opencodeGlobalConfig).toBeUndefined();
				expect(config.opencodeRepositoryConfig).toBeUndefined();
				expect(config.opencodeStateScope).toBeUndefined();
				expect(config.opencodeStateKey).toBeUndefined();
			}
		}
	});
});
