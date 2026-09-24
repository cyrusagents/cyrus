import type { ILogger, MikoAgentSession, RepositoryConfig } from "miko-core";
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

function makeBuilder(runnerType: "codex" | "cursor"): RunnerConfigBuilder {
	const chatToolResolver: IChatToolResolver = {
		buildChatAllowedTools: () => ["Read(**)"],
	};
	const mcpConfigProvider: IMcpConfigProvider = {
		buildMcpConfig: () => ({}),
		buildMergedMcpConfigPath: () => undefined,
	};
	const runnerSelector: IRunnerSelector = {
		determineRunnerSelection: () => ({ runnerType }),
		getDefaultModelForRunner: () => "gpt-5.5",
		getDefaultFallbackModelForRunner: () => "gpt-5.2-codex",
	};
	return new RunnerConfigBuilder(
		chatToolResolver,
		mcpConfigProvider,
		runnerSelector,
	);
}

describe("RunnerConfigBuilder Codex managed skills", () => {
	it.each([
		"codex",
		"cursor",
	] as const)("passes scoped plugins and skill names to %s runner configs", (expectedRunner) => {
		const session = {
			issueId: "issue-1",
			issue: { identifier: "ABC-1" },
			workspace: {
				path: "/ws/repo-a",
				isGitWorktree: true,
			},
		} as unknown as MikoAgentSession;
		const repository = {
			id: "repo-a",
			name: "Repo A",
			repositoryPath: "/repos/repo-a",
			allowedTools: [],
		} as unknown as RepositoryConfig;
		const plugins = [{ type: "local" as const, path: "/miko/user-skills" }];

		const { config, runnerType } = makeBuilder(expectedRunner).buildIssueConfig(
			{
				session,
				repository,
				sessionId: "sess-1",
				systemPrompt: "test",
				allowedTools: ["Read(**)"],
				allowedDirectories: ["/repos/repo-a"],
				disallowedTools: [],
				mikoHome: "/tmp/miko-home",
				linearWorkspaceId: "ws-1",
				logger: silentLogger,
				onMessage: () => {},
				onError: () => {},
				requireLinearWorkspaceId: () => "ws-1",
				plugins,
				skills: ["custom-user"],
			},
		);

		expect(runnerType).toBe(expectedRunner);
		expect(config.plugins).toEqual(plugins);
		expect(config.skills).toEqual(["custom-user"]);
		expect(config.codexHome).toBeUndefined();
	});
});
