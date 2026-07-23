import type { CyrusAgentSession, ILogger, RepositoryConfig } from "cyrus-core";
import { describe, expect, it } from "vitest";
import {
	type IChatToolResolver,
	type IMcpConfigProvider,
	type IRunnerSelector,
	RunnerConfigBuilder,
} from "../src/RunnerConfigBuilder.js";

type RunnerSelection = ReturnType<IRunnerSelector["determineRunnerSelection"]>;

const silentLogger: ILogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
} as unknown as ILogger;

function makeBuilder(
	selection: RunnerSelection = { runnerType: "codex" },
): RunnerConfigBuilder {
	const chatToolResolver: IChatToolResolver = {
		buildChatAllowedTools: () => ["Read(**)"],
	};
	const mcpConfigProvider: IMcpConfigProvider = {
		buildMcpConfig: () => ({}),
		buildMergedMcpConfigPath: () => undefined,
	};
	const runnerSelector: IRunnerSelector = {
		determineRunnerSelection: () => selection,
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
	it("passes scoped plugins and skill names to Codex runner configs", () => {
		const session = {
			issueId: "issue-1",
			issue: { identifier: "ABC-1" },
			workspace: {
				path: "/ws/repo-a",
				isGitWorktree: true,
			},
		} as unknown as CyrusAgentSession;
		const repository = {
			id: "repo-a",
			name: "Repo A",
			repositoryPath: "/repos/repo-a",
			allowedTools: [],
		} as unknown as RepositoryConfig;
		const plugins = [{ type: "local" as const, path: "/cyrus/user-skills" }];

		const { config, runnerType } = makeBuilder().buildIssueConfig({
			session,
			repository,
			sessionId: "sess-1",
			systemPrompt: "test",
			allowedTools: ["Read(**)"],
			allowedDirectories: ["/repos/repo-a"],
			disallowedTools: [],
			cyrusHome: "/tmp/cyrus-home",
			linearWorkspaceId: "ws-1",
			logger: silentLogger,
			onMessage: () => {},
			onError: () => {},
			requireLinearWorkspaceId: () => "ws-1",
			plugins,
			skills: ["custom-user"],
		});

		expect(runnerType).toBe("codex");
		expect(config.plugins).toEqual(plugins);
		expect(config.skills).toEqual(["custom-user"]);
		expect(config.codexHome).toBeUndefined();
	});

	it("passes GPT-5.6 model and reasoning effort into the Codex config", () => {
		const session = {
			issueId: "issue-1",
			issue: { identifier: "ABC-1" },
			workspace: { path: "/ws/repo-a", isGitWorktree: true },
		} as unknown as CyrusAgentSession;
		const repository = {
			id: "repo-a",
			name: "Repo A",
			repositoryPath: "/repos/repo-a",
			allowedTools: [],
		} as unknown as RepositoryConfig;

		const { config, runnerType } = makeBuilder({
			runnerType: "codex",
			modelOverride: "gpt-5.6-luna",
			fallbackModelOverride: "gpt-5.2-codex",
			reasoningEffort: "high",
		}).buildIssueConfig({
			session,
			repository,
			sessionId: "sess-1",
			systemPrompt: "test",
			allowedTools: ["Read(**)"],
			allowedDirectories: ["/repos/repo-a"],
			disallowedTools: [],
			cyrusHome: "/tmp/cyrus-home",
			linearWorkspaceId: "ws-1",
			logger: silentLogger,
			onMessage: () => {},
			onError: () => {},
			requireLinearWorkspaceId: () => "ws-1",
		});

		expect(runnerType).toBe("codex");
		expect(config.model).toBe("gpt-5.6-luna");
		expect((config as Record<string, unknown>).modelReasoningEffort).toBe(
			"high",
		);
		expect(config.model).not.toBe("sonnet");
	});
});
