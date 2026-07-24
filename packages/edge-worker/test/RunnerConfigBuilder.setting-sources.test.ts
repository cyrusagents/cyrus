import type { CyrusAgentSession, ILogger, RepositoryConfig } from "cyrus-core";
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
		getDefaultModelForRunner: () => "opus",
		getDefaultFallbackModelForRunner: () => "sonnet",
	};
	return new RunnerConfigBuilder(
		chatToolResolver,
		mcpConfigProvider,
		runnerSelector,
	);
}

function makeRepository(
	overrides: Partial<RepositoryConfig> = {},
): RepositoryConfig {
	return {
		id: "repo-a",
		name: "Repo A",
		repositoryPath: "/repos/repo-a",
		allowedTools: [],
		...overrides,
	} as unknown as RepositoryConfig;
}

function makeSession(): CyrusAgentSession {
	return {
		issueId: "issue-1",
		issue: { identifier: "ABC-1" },
		workspace: { path: "/ws/repo-a-worktree", isGitWorktree: true },
	} as unknown as CyrusAgentSession;
}

function buildIssueConfig(repository: RepositoryConfig) {
	return makeBuilder().buildIssueConfig({
		session: makeSession(),
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
}

describe("RunnerConfigBuilder settingSources (per-repository override, Claude runner only)", () => {
	it("threads a valid repository.settingSources override into the runner config", () => {
		const repository = makeRepository({ settingSources: ["project"] });

		const { config } = buildIssueConfig(repository);

		expect(config.settingSources).toEqual(["project"]);
	});

	it("omits settingSources from the config when repository has no override", () => {
		const repository = makeRepository();

		const { config } = buildIssueConfig(repository);

		expect(config.settingSources).toBeUndefined();
	});

	it("omits an invalid repository.settingSources override rather than passing it through", () => {
		const repository = makeRepository({
			settingSources: [
				"bogus",
			] as unknown as RepositoryConfig["settingSources"],
		});

		const { config } = buildIssueConfig(repository);

		expect(config.settingSources).toBeUndefined();
	});

	it("omits an empty repository.settingSources override", () => {
		const repository = makeRepository({ settingSources: [] });

		const { config } = buildIssueConfig(repository);

		expect(config.settingSources).toBeUndefined();
	});
});
