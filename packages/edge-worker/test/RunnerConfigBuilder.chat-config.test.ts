import { join } from "node:path";
import type { ILogger } from "cyrus-core";
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
	const chatToolResolver: IChatToolResolver = {
		buildChatAllowedTools: () => ["Read(**)"],
	};
	const mcpConfigProvider: IMcpConfigProvider = {
		buildMcpConfig: () => ({}),
		buildMergedMcpConfigPath: () => undefined,
	};
	const runnerSelector: IRunnerSelector = {
		determineRunnerSelection: () => ({ runnerType: "claude" as const }),
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
});

describe("RunnerConfigBuilder.buildIssueConfig", () => {
	it("passes scoped skills plugins to OpenCode issue sessions", () => {
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
		expect((config as any).plugins).toBe(plugins);
		expect((config as any).skills).toEqual(["debug"]);
	});
});
